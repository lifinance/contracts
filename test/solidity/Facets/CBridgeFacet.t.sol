// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount } from "../utils/TestBaseFacet.sol";
import { CBridgeFacet, IMessageBus, MsgDataTypes } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(
        ICBridge _cBridge,
        IMessageBus _messageBus,
        RelayerCelerIM _relayer
    ) CBridgeFacet(_cBridge, _messageBus, _relayer) {}

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

contract CBridgeFacetTest is TestBaseFacet {
    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address internal constant CBRIDGE_MESSAGEBUS_ETH = 0x4066D196A423b2b3B8B054f4F40efB47a74E200C;
    TestCBridgeFacet internal cBridgeFacet;
    CBridgeFacet.CBridgeData internal cBridgeData;
    Executor internal executor;
    ERC20Proxy internal erc20Proxy;
    RelayerCelerIM internal relayer;

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            cBridgeFacet.startBridgeTokensViaCBridge{ value: bridgeData.minAmount }(bridgeData, cBridgeData);
        } else {
            cBridgeFacet.startBridgeTokensViaCBridge(bridgeData, cBridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            cBridgeFacet.swapAndStartBridgeTokensViaCBridge{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                cBridgeData
            );
        } else {
            cBridgeFacet.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, cBridgeData);
        }
    }

    function setUp() public {
        initTestBase();

        // deploy periphery
        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(this), address(erc20Proxy));
        relayer = new RelayerCelerIM(address(this), CBRIDGE_MESSAGEBUS_ETH, address(diamond), address(executor));

        cBridgeFacet = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER), IMessageBus(CBRIDGE_MESSAGEBUS_ETH), relayer);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = cBridgeFacet.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridgeFacet.swapAndStartBridgeTokensViaCBridge.selector;
        functionSelectors[2] = cBridgeFacet.addDex.selector;
        functionSelectors[3] = cBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(cBridgeFacet), functionSelectors);

        cBridgeFacet = TestCBridgeFacet(address(diamond));
        cBridgeFacet.addDex(address(uniswap));
        cBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        cBridgeFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        cBridgeFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(cBridgeFacet), "cBridgeFacet");
        vm.label(CBRIDGE_ROUTER, "CBRIDGE_ROUTER");
        vm.label(CBRIDGE_MESSAGEBUS_ETH, "CBRIDGE_MESSAGEBUS_ETH");

        cBridgeData = CBridgeFacet.CBridgeData({
            maxSlippage: 5000,
            nonce: 1,
            callTo: abi.encodePacked(address(0)),
            callData: "",
            messageBusFee: 0,
            bridgeType: MsgDataTypes.BridgeSendType.Liquidity
        });
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
            abi.encodeWithSelector(cBridgeFacet.startBridgeTokensViaCBridge.selector, bridgeData, cBridgeData)
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
                    address(cBridgeFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                cBridgeFacet.swapAndStartBridgeTokensViaCBridge.selector,
                bridgeData,
                swapData,
                cBridgeData
            )
        );
    }

    function test_Revert_NativeBridgingWithInsufficientMsgValue() public {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        vm.expectRevert();

        cBridgeFacet.startBridgeTokensViaCBridge{ value: bridgeData.minAmount - 1 }(bridgeData, cBridgeData);

        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

    function test_Revert_CallRefundFromAnyAccount() public {
        //TODO
    }

    function test_WillProcessRefundOnSrcChainIfCalledByMessageBus() public {
        uint64 srcChainId = 137;

        // create swap data
        delete swapData;
        // Swap DAI -> USDC
        address[] memory swapPath = new address[](2);
        swapPath[0] = ADDRESS_DAI;
        swapPath[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, swapPath);
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
                    swapPath,
                    address(executor),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // create callData that will be sent to our diamond on srcChain (from CBridge MessageBus)
        bytes32 transactionId = 0x7472616e73616374696f6e496400000000000000000000000000000000000000;
        bytes memory payload = abi.encode(transactionId, swapData, USER_RECEIVER, USER_REFUND);

        // fund diamond with sufficient DAI to execute swap
        deal(ADDRESS_DAI, address(relayer), swapData[0].fromAmount);

        // call executeMessageWithTransfer function as CBridge MessageBus router
        vm.startPrank(CBRIDGE_MESSAGEBUS_ETH);

        // prepare check for events
        vm.expectEmit(true, true, true, true, address(executor));
        emit AssetSwapped(
            transactionId,
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, address(executor));
        emit LiFiTransferCompleted(transactionId, ADDRESS_DAI, USER_RECEIVER, defaultUSDCAmount, block.timestamp);

        // call function in ReceiverCelerIM to complete transaction
        relayer.executeMessageWithTransfer(
            address(this),
            ADDRESS_DAI,
            swapData[0].fromAmount,
            srcChainId,
            payload,
            address(this)
        );
    }
}
