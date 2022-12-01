// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE
import { NoSwapDataProvided, InformationMismatch, NativeAssetTransferFailed, ReentrancyError, InsufficientBalance, CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount, InvalidConfig, InvalidSendingToken, AlreadyInitialized, NotInitialized } from "src/Errors/GenericErrors.sol";

contract TestFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ReentrancyChecker is DSTest {
    address private _facetAddress;
    bytes private _callData;

    constructor(address facetAddress) {
        _facetAddress = facetAddress;
        ERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).approve(_facetAddress, type(uint256).max); // approve USDC max to facet
        ERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F).approve(_facetAddress, type(uint256).max); // approve DAI max to facet
    }

    // must be called with abi.encodePacked(selector, someParam)
    // selector = function selector of the to-be-checked function
    // someParam = valid arguments for the function call
    function callFacet(bytes calldata callData) public {
        _callData = callData;
        (bool success, bytes memory data) = _facetAddress.call{ value: 10 ether }(callData);
        if (!success) {
            if (keccak256(data) == keccak256(abi.encodePacked(NativeAssetTransferFailed.selector))) {
                revert ReentrancyError();
            } else {
                revert("Reentrancy Attack Test: initial call failed");
            }
        }
    }

    receive() external payable {
        (bool success, bytes memory data) = _facetAddress.call{ value: 10 ether }(_callData);
        if (!success) {
            if (keccak256(data) == keccak256(abi.encodePacked(ReentrancyError.selector))) {
                revert ReentrancyError();
            } else {
                revert("Reentrancy Attack Test: reentrant call failed");
            }
        }
    }
}

//common utilities for forge tests
abstract contract TestBase is DSTest, DiamondTest, ILiFi {
    address private _facetTestContractAddress;
    uint64 internal currentTxId;
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    bytes32 internal nextUser = keccak256(abi.encodePacked("user address"));
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    LiFiDiamond internal diamond;
    ILiFi.BridgeData internal bridgeData;
    LibSwap.SwapData[] internal swapData;
    uint256 internal defaultDAIAmount;
    uint256 internal defaultUSDCAmount;
    // tokenAddress => userAddress => balance
    mapping(address => mapping(address => uint256)) internal initialBalances;
    uint256 internal addToMessageValue;

    // EVENTS
    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );
    event Transfer(address from, address to, uint256 amount);

    // CONSTANTS
    // Contract addresses (ETH only)
    address internal constant ADDRESS_UNISWAP = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // User accounts (Whales: ETH only)
    address internal constant USER_SENDER = address(0xabc123456); // initially funded with 100,000 DAI, USDC & ETHER
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_REFUND = address(0xabcdef281);
    address internal constant USER_DIAMOND_OWNER = 0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;
    address internal constant USER_USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant USER_DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;

    // MODIFIERS

    //@dev token == address(0) => check balance of native token
    modifier assertBalanceChange(
        address token,
        address user,
        int256 amount
    ) {
        // store initial balance
        if (token == address(0)) {
            initialBalances[token][user] = user.balance;
        } else {
            initialBalances[token][user] = ERC20(token).balanceOf(user);
        }

        //execute function
        _;

        //check post-execution balances
        uint256 currentBalance;
        if (token == address(0)) {
            currentBalance = user.balance;
        } else {
            currentBalance = ERC20(token).balanceOf(user);
        }
        uint256 expectedBalance = uint256(int256(initialBalances[token][user]) + amount);
        assertEq(currentBalance, expectedBalance);
    }

    // FUNCTIONS
    function initTestBase() internal {
        // activate fork
        fork();

        // fill user accounts with starting balance
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
        usdc = ERC20(ADDRESS_USDC);
        dai = ERC20(ADDRESS_DAI);

        // deploy & configure diamond
        diamond = createDiamond();

        // transfer initial DAI/USDC balance to USER_SENDER
        vm.startPrank(USER_USDC_WHALE);
        usdc.transfer(USER_SENDER, 100_000 * 10**usdc.decimals());
        vm.stopPrank();
        vm.startPrank(USER_DAI_WHALE);
        dai.transfer(USER_SENDER, 100_000 * 10**dai.decimals());
        vm.stopPrank();

        vm.deal(USER_SENDER, 1000 ether);

        defaultDAIAmount = 100 * 10**dai.decimals();
        defaultUSDCAmount = 100 * 10**usdc.decimals();

        setDefaultBridgeData();
        setDefaultSwapDataSingleDAItoUSDC();
    }

    function setFacetAddressInTestBase(address facetAddress) internal {
        _facetTestContractAddress = facetAddress;
    }

    function fork() internal virtual {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setDefaultBridgeData() internal {
        bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "<UpdateWithYourBridgeName>",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_USDC,
            receiver: USER_RECEIVER,
            minAmount: defaultUSDCAmount,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    function setDefaultSwapDataSingleDAItoUSDC() internal virtual {
        delete swapData;
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    //#region defaultTests (will be executed for every contract that inherits this contract)
    //@dev in case you want to exclude any of these test cases, you must override test case in child contract with empty body:
    //@dev e.g. "function testBaseCanBridgeTokens() public override {}"

    function testBase_CanBridgeTokens()
        public
        virtual
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, -int256(defaultUSDCAmount))
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens()
        public
        virtual
        assertBalanceChange(address(0), USER_SENDER, -int256((1 ether + addToMessageValue)))
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
    {
        vm.startPrank(USER_SENDER);
        // customize bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens()
        public
        virtual
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, -int256(swapData[0].fromAmount))
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_CanSwapAndBridgeNativeTokens()
        public
        virtual
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);
        // store initial balances
        // uint256 initialDAIBalance = dai.balanceOf(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        // prepare swap data
        setDefaultSwapDataSingleDAItoUSDC();
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            address(0),
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // approval
        dai.approve(_facetTestContractAddress, amountIn);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(true);

        // check balances after call
        // assertEq(dai.balanceOf(USER_SENDER), initialDAIBalance - swapData[0].fromAmount);
    }

    function testBase_Revert_BridgeWithInvalidDestinationCallFlag() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.receiver = address(0);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.receiver = address(0);
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(InvalidReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidAmount() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.minAmount = 0;

        vm.expectRevert(InvalidAmount.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidAmount() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = 0;

        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(InvalidAmount.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_BridgeToSameChainId() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = 1;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeToSameChainId() public virtual {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.destinationChainId = 1;
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_Revert_SwapAndBridgeWithInvalidSwapData() public virtual {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset swap data
        delete swapData;

        vm.expectRevert(NoSwapDataProvided.selector);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag() public virtual {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InformationMismatch.selector);

        // execute call in child contract
        initiateBridgeTxWithFacet(false);
    }

    function testBase_Revert_CallerHasInsufficientFunds() public virtual {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(_facetTestContractAddress), defaultUSDCAmount);

        usdc.transfer(USER_RECEIVER, usdc.balanceOf(USER_SENDER));

        vm.expectRevert(abi.encodeWithSelector(InsufficientBalance.selector, bridgeData.minAmount, 0));
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    //#endregion

    //#region optionalTests (must be called explicitly from inheriting contract)

    // checks if function is protected by nonReentrant modifier
    //! only works if function is also protected with "refundExcessiveGas" modifier
    function failReentrantCall(bytes memory callData) internal virtual {
        // deploy and call attacker contract
        ReentrancyChecker attacker = new ReentrancyChecker(_facetTestContractAddress);
        dai.transfer(address(attacker), dai.balanceOf(USER_SENDER));
        vm.deal(address(attacker), 10000 ether);
        vm.expectRevert(ReentrancyError.selector);
        attacker.callFacet(callData);
    }

    //#endregion

    //#region abstract functions

    // this function must be implemented by the facet test contract
    // it will contain the logic to:
    // a) prepare the facet-specific data
    // b) call the correct function selectors (as they differ for each facet)
    function initiateBridgeTxWithFacet(bool isNative) internal virtual;

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal virtual;

    //#endregion

    //#region existing functions of utilities.sol
    function getNextUserAddress() external returns (address payable) {
        //bytes32 to address conversion
        address payable user = payable(address(uint160(uint256(nextUser))));
        nextUser = keccak256(abi.encodePacked(nextUser));
        return user;
    }

    //create users with 100 ether balance
    function createUsers(uint256 userNum) external returns (address payable[] memory) {
        address payable[] memory users = new address payable[](userNum);
        for (uint256 i = 0; i < userNum; i++) {
            address payable user = this.getNextUserAddress();
            vm.deal(user, 100 ether);
            users[i] = user;
        }
        return users;
    }

    //move block.number forward by a given number of blocks
    function mineBlocks(uint256 numBlocks) external {
        uint256 targetBlock = block.number + numBlocks;
        vm.roll(targetBlock);
    }
    //#endregion
}
