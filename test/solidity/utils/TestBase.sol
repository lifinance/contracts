// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0;

import { Test, DSTest } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE
import { NoSwapDataProvided, InformationMismatch, NativeAssetTransferFailed, ReentrancyError, InsufficientBalance, CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount, InvalidConfig, InvalidSendingToken, AlreadyInitialized, NotInitialized, UnAuthorized } from "src/Errors/GenericErrors.sol";

contract TestFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ReentrancyChecker {
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
abstract contract TestBase is Test, DiamondTest, ILiFi {
    address internal _facetTestContractAddress;
    uint64 internal currentTxId;
    bytes32 internal nextUser = keccak256(abi.encodePacked("user address"));
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    ERC20 internal weth;
    LiFiDiamond internal diamond;
    ILiFi.BridgeData internal bridgeData;
    LibSwap.SwapData[] internal swapData;
    uint256 internal defaultDAIAmount;
    uint256 internal defaultUSDCAmount;
    // tokenAddress => userAddress => balance
    mapping(address => mapping(address => uint256)) internal initialBalances;
    uint256 internal addToMessageValue;
    // set these custom values in your test file to
    uint256 internal customBlockNumberForForking;
    string internal customRpcUrlForForking;
    string internal logFilePath;

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
    // Forking
    uint256 internal constant DEFAULT_BLOCK_NUMBER_MAINNET = 15588208;

    // Contract addresses (ETH only)
    address internal ADDRESS_UNISWAP = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // User accounts (Whales: ETH only)
    address internal constant USER_SENDER = address(0xabc123456); // initially funded with 100,000 DAI, USDC & ETHER
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_REFUND = address(0xabcdef281);
    address internal constant USER_DIAMOND_OWNER = 0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;
    address internal constant USER_USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant USER_DAI_WHALE = 0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;
    address internal constant USER_WETH_WHALE = 0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E;

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
        // label addresses (for better readability in error traces)
        vm.label(USER_SENDER, "USER_SENDER");
        vm.label(USER_RECEIVER, "USER_RECEIVER");
        vm.label(USER_REFUND, "USER_REFUND");
        vm.label(USER_DIAMOND_OWNER, "USER_DIAMOND_OWNER");
        vm.label(USER_USDC_WHALE, "USER_USDC_WHALE");
        vm.label(USER_DAI_WHALE, "USER_DAI_WHALE");
        vm.label(ADDRESS_USDC, "ADDRESS_USDC_PROXY");
        vm.label(0xa2327a938Febf5FEC13baCFb16Ae10EcBc4cbDCF, "ADDRESS_USDC_IMPL");
        vm.label(ADDRESS_DAI, "ADDRESS_DAI");
        vm.label(ADDRESS_UNISWAP, "ADDRESS_UNISWAP");
        vm.label(ADDRESS_WETH, "ADDRESS_WETH_PROXY");

        // activate fork
        fork();

        // fill user accounts with starting balance
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
        usdc = ERC20(ADDRESS_USDC);
        dai = ERC20(ADDRESS_DAI);
        weth = ERC20(ADDRESS_WETH);

        // deploy & configure diamond
        diamond = createDiamond();

        // transfer initial DAI/USDC/WETH balance to USER_SENDER
        deal(ADDRESS_USDC, USER_SENDER, 100_000 * 10**usdc.decimals());
        deal(ADDRESS_DAI, USER_SENDER, 100_000 * 10**dai.decimals());
        deal(ADDRESS_WETH, USER_SENDER, 100_000 * 10**weth.decimals());

        // fund USER_SENDER with 1000 ether
        vm.deal(USER_SENDER, 1000 ether);

        // initiate variables
        defaultDAIAmount = 100 * 10**dai.decimals();
        defaultUSDCAmount = 100 * 10**usdc.decimals();

        // set path for logfile (esp. interesting for fuzzing tests)
        logFilePath = "./test/logs/";
        vm.writeFile(
            logFilePath,
            string.concat("\n Logfile created at timestamp: ", string.concat(vm.toString(block.timestamp), "\n"))
        );

        setDefaultBridgeData();
    }

    function setFacetAddressInTestBase(address facetAddress, string memory facetName) internal {
        _facetTestContractAddress = facetAddress;
        setDefaultSwapDataSingleDAItoUSDC();
        vm.label(facetAddress, facetName);
    }

    function fork() internal virtual {
        string memory rpcUrl = bytes(customRpcUrlForForking).length != 0
            ? customRpcUrlForForking
            : vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = customBlockNumberForForking > 0 ? customBlockNumberForForking : vm.envUint("FORK_NUMBER");

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

    //@dev: be careful that _facetTestContractAddress is set before calling this function
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

    //@dev: be careful that _facetTestContractAddress is set before calling this function
    function setDefaultSwapDataSingleDAItoETH() internal virtual {
        delete swapData;
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WETH;

        uint256 amountOut = 1 ether;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    //#region Utility Functions (may be used in tests)

    function printBridgeData(ILiFi.BridgeData memory _bridgeData) internal {
        console.log("----------------------------------");
        console.log("CURRENT VALUES OF _bridgeData: ");
        emit log_named_bytes32("transactionId               ", _bridgeData.transactionId);
        emit log_named_string("bridge                      ", _bridgeData.bridge);
        emit log_named_string("integrator                  ", _bridgeData.integrator);
        emit log_named_address("referrer                    ", _bridgeData.referrer);
        emit log_named_address("sendingAssetId              ", _bridgeData.sendingAssetId);
        emit log_named_address("receiver                    ", _bridgeData.receiver);
        emit log_named_uint("minAmount                   ", _bridgeData.minAmount);
        emit log_named_uint("destinationChainId          ", _bridgeData.destinationChainId);
        console.log("hasSourceSwaps              :", _bridgeData.hasSourceSwaps);
        console.log("hasDestinationCall          :", _bridgeData.hasDestinationCall);
        console.log("------------- END -----------------");
    }

    function fuelAccountWithERC20(
        address tokenAddress,
        address to,
        address tokenWhale,
        uint256 amount
    ) internal {
        vm.startPrank(tokenWhale);
        ERC20(tokenAddress).transfer(to, amount);
        vm.stopPrank();
    }

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
