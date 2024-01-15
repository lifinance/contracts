// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount } from "../utils/TestBaseFacet.sol";
import { CelerIMFacetMutable, IMessageBus, MsgDataTypes, IERC20, CelerIM } from "lifi/Facets/CelerIMFacetMutable.sol";
import { IBridge as ICBridge } from "celer-network/contracts/interfaces/IBridge.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

// Stub CelerIMFacet Contract
contract TestCelerIMFacet is CelerIMFacetMutable {
    constructor(
        IMessageBus _messageBus,
        address _relayerOwner,
        address _diamondAddress,
        address _cfUSDC,
        address _feeCollector
    )
        CelerIMFacetMutable(
            _messageBus,
            _relayerOwner,
            _diamondAddress,
            _cfUSDC,
            _feeCollector
        )
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

interface Ownable {
    function owner() external returns (address);
}

contract CelerIMFacetTest is TestBaseFacet {
    /// EVENTS
    event Deposited(
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint64 mintChainId,
        address mintAccount,
        uint64 nonce
    );
    event Mint(
        bytes32 mintId,
        address token,
        address account,
        uint256 amount,
        uint64 refChainId,
        bytes32 refId,
        address depositor
    );
    event Burn(
        bytes32 burnId,
        address token,
        address account,
        uint256 amount,
        address withdrawAccount
    );
    event Burn(
        bytes32 burnId,
        address token,
        address account,
        uint256 amount,
        uint64 toChainId,
        address toAccount,
        uint64 nonce
    );

    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant CBRIDGE_MESSAGEBUS_ETH =
        0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
    address internal constant CBRIDGE_PEG_VAULT =
        0xB37D31b2A74029B5951a2778F959282E2D518595;
    address internal constant CBRIDGE_PEG_VAULT_V2 =
        0x7510792A3B1969F9307F3845CE88e39578f2bAE1;
    address internal constant CBRIDGE_PEG_BRIDGE =
        0x16365b45EB269B5B5dACB34B4a15399Ec79b95eB;
    address internal constant CBRIDGE_PEG_BRIDGE_V2 =
        0x52E4f244f380f8fA51816c8a10A63105dd4De084;
    address internal constant CFUSDC =
        0x317F8d18FB16E49a958Becd0EA72f8E153d25654;

    TestCelerIMFacet internal celerIMFacet;
    CelerIM.CelerIMData internal celerIMData;
    Executor internal executor;
    ERC20Proxy internal erc20Proxy;
    RelayerCelerIM internal relayer;
    FeeCollector internal feeCollector;

    function setUp() public {
        customBlockNumberForForking = 16227237;
        initTestBase();

        // deploy periphery
        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy));
        feeCollector = new FeeCollector(address(this));

        celerIMFacet = new TestCelerIMFacet(
            IMessageBus(CBRIDGE_MESSAGEBUS_ETH),
            REFUND_WALLET,
            address(diamond),
            CFUSDC,
            address(feeCollector)
        );

        relayer = celerIMFacet.relayer();

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = celerIMFacet
            .startBridgeTokensViaCelerIM
            .selector;
        functionSelectors[1] = celerIMFacet
            .swapAndStartBridgeTokensViaCelerIM
            .selector;
        functionSelectors[2] = celerIMFacet.addDex.selector;
        functionSelectors[3] = celerIMFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(celerIMFacet), functionSelectors);

        celerIMFacet = TestCelerIMFacet(address(diamond));
        celerIMFacet.addDex(address(uniswap));
        celerIMFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        celerIMFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        celerIMFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        setFacetAddressInTestBase(address(celerIMFacet), "cBridgeFacet");
        vm.label(CBRIDGE_ROUTER, "CBRIDGE_ROUTER");
        vm.label(CBRIDGE_MESSAGEBUS_ETH, "CBRIDGE_MESSAGEBUS_ETH");
        vm.label(CBRIDGE_PEG_VAULT, "CBRIDGE_PEG_VAULT");
        vm.label(CBRIDGE_PEG_VAULT_V2, "CBRIDGE_PEG_VAULT_V2");
        vm.label(CBRIDGE_PEG_BRIDGE, "CBRIDGE_PEG_BRIDGE");
        vm.label(CBRIDGE_PEG_BRIDGE_V2, "CBRIDGE_PEG_BRIDGE_V2");

        celerIMData = CelerIM.CelerIMData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            celerIMFacet.startBridgeTokensViaCelerIM{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, celerIMData);
        } else {
            celerIMFacet.startBridgeTokensViaCelerIM{
                value: addToMessageValue
            }(bridgeData, celerIMData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            celerIMFacet.swapAndStartBridgeTokensViaCelerIM{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, celerIMData);
        } else {
            celerIMFacet.swapAndStartBridgeTokensViaCelerIM{
                value: addToMessageValue
            }(bridgeData, swapData, celerIMData);
        }
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(_facetTestContractAddress), defaultUSDCAmount);

        usdc.transfer(USER_RECEIVER, usdc.balanceOf(USER_SENDER));

        vm.expectRevert();
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_Revert_ReentrantCallBridge() internal {
        // prepare bridge data for native bridging
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                celerIMFacet.startBridgeTokensViaCelerIM.selector,
                bridgeData,
                celerIMData
            )
        );
    }

    function test_Revert_ReentrantCallBridgeAndSwap() public {
        vm.startPrank(USER_SENDER);

        // prepare bridge data for native bridging
        bridgeData.hasSourceSwaps = true;

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
                    address(celerIMFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                celerIMFacet.swapAndStartBridgeTokensViaCelerIM.selector,
                bridgeData,
                swapData,
                celerIMData
            )
        );
    }

    function test_Revert_NativeBridgingWithInsufficientMsgValue() public {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        vm.expectRevert();

        celerIMFacet.startBridgeTokensViaCelerIM{
            value: bridgeData.minAmount - 1
        }(bridgeData, celerIMData);

        vm.stopPrank();
    }

    function test_CanBridgeNativeTokens_DestinationCall() public {
        addToMessageValue = 1e17;
        celerIMData = CelerIM.CelerIMData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(1)),
            callData: abi.encode(
                bytes32(""),
                swapData,
                USER_SENDER,
                USER_SENDER
            ),
            messageBusFee: addToMessageValue,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });
        bridgeData.hasDestinationCall = true;

        super.testBase_CanBridgeNativeTokens();
    }

    function test_CanSwapAndBridgeNativeTokens_DestinationCall() public {
        addToMessageValue = 1e17;
        celerIMData = CelerIM.CelerIMData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(1)),
            callData: abi.encode(
                bytes32(""),
                swapData,
                USER_SENDER,
                USER_SENDER
            ),
            messageBusFee: addToMessageValue,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });
        bridgeData.hasDestinationCall = true;

        super.testBase_CanSwapAndBridgeNativeTokens();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

    function test_canBridgeTokens_PegDeposit() public {
        vm.startPrank(USER_SENDER);
        // reference tx: https://etherscan.io/tx/0xa91fd8a0b703bfec29c6682dcf2fc022db82b250e3d8544ad5efcef5dd245cb5

        // adjust cBridgeData
        celerIMData.bridgeType = MsgDataTypes.BridgeSendType.PegDeposit;

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);

        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_canBridgeTokens_PegBurn() public {
        vm.startPrank(USER_SENDER);
        IERC20 testToken = IERC20(0xe593F3509eb2a620DC61078bcdEDbA355F083E8B);
        // reference tx: https://etherscan.io/tx/0x4c1482748b174892ca7dcb90f882afb6355dcb8f26d527b763a780c23163f235

        // transfer testToken to USER_SENDER
        deal(address(testToken), USER_SENDER, 10_000e18);

        // adjust cBridgeData
        bridgeData.sendingAssetId = address(testToken);
        bridgeData.minAmount = defaultDAIAmount;

        // adjust cBridgeData
        celerIMData.bridgeType = MsgDataTypes.BridgeSendType.PegBurn;

        // approval
        testToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(false, false, false, false, CBRIDGE_PEG_BRIDGE);
        emit Burn(
            0xe3d9751d87739cd7f22c724ec6d301d415e6281c82b0fad26e9df280d57ccce8,
            address(testToken),
            address(relayer),
            bridgeData.minAmount,
            USER_RECEIVER
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_canBridgeTokens_PegV2Deposit() public {
        vm.startPrank(USER_SENDER);
        // reference tx: https://etherscan.io/tx/0x254df9e7b55e1c2fa2eee9ebd772f13eeb235fa8852d2fbd04ca3855e8b8435c

        // adjust cBridgeData
        bridgeData.sendingAssetId = ADDRESS_WETH;
        bridgeData.minAmount = defaultDAIAmount;

        // adjust cBridgeData
        celerIMData.bridgeType = MsgDataTypes.BridgeSendType.PegV2Deposit;

        // approval
        weth.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(false, false, false, false, CBRIDGE_PEG_VAULT_V2);
        emit Deposited(
            0x4d1740ad079e2cae12e52778c379c75aa39ea6fc3e45ab1263966bd3ea6c031c,
            address(relayer),
            ADDRESS_WETH,
            bridgeData.minAmount,
            uint64(bridgeData.destinationChainId),
            USER_RECEIVER,
            1
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_canBridgeNativeTokens_PegV2Deposit() public {
        vm.startPrank(USER_SENDER);
        // reference tx: https://etherscan.io/tx/0x0b1bf1fbde35cd11a103fae96045e1d14a2cdba9c06f1c557c20140920251bcd

        // adjust cBridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultDAIAmount;

        // adjust cBridgeData
        celerIMData.bridgeType = MsgDataTypes.BridgeSendType.PegV2Deposit;

        //prepare check for events
        vm.expectEmit(false, false, false, false, CBRIDGE_PEG_VAULT_V2);
        emit Deposited(
            0x9e3e2a8aae04ccdd70d83859e3914bf003eef7f022f3259194af9bb551a48cd3,
            address(relayer),
            ADDRESS_WETH,
            bridgeData.minAmount,
            uint64(bridgeData.destinationChainId),
            USER_RECEIVER,
            1
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function test_canBridgeTokens_PegV2Burn() public {
        vm.startPrank(USER_SENDER);
        IERC20 testToken = IERC20(0xA719CB79Af39A9C10eDA2755E0938bCE35e9DE24); // Starfish Token
        // reference tx: https://etherscan.io/tx/0xa32470a629b419069dfe62035193a8dd90f050b4773fe23b2f754d610eae04d0

        // transfer testToken to USER_SENDER
        deal(address(testToken), USER_SENDER, 10_000e18);

        // adjust cBridgeData
        bridgeData.sendingAssetId = address(testToken);
        bridgeData.minAmount = defaultDAIAmount;

        // adjust cBridgeData
        celerIMData.bridgeType = MsgDataTypes.BridgeSendType.PegV2Burn;

        // approval
        testToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(false, false, false, false, CBRIDGE_PEG_BRIDGE_V2);
        emit Burn(
            0x906377c64da8ed8374879c2f56b5c47fc148ab77f157d1267e52dd6a4a885434,
            address(testToken),
            address(relayer),
            bridgeData.minAmount,
            uint64(bridgeData.destinationChainId),
            USER_RECEIVER,
            1
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_canBridgeTokens_PegV2BurnFrom() public {
        // reference: https://explorer.swimmer.network/tx/0x14c3a392d2fbceacc6e48316249efdd80fbe5511c17cffd8806a276333d48cdd/token-transfers
        // no reference tx on ETH
        // highly unlikely we will encounter this case, therefore chose to not implement this test case
    }
}
