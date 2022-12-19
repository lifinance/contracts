// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount } from "../utils/TestBaseFacet.sol";
import { CBridgeFacet, IMessageBus, MsgDataTypes } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(ICBridge _cBridge, IMessageBus _messageBus) CBridgeFacet(_cBridge, _messageBus) {}

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
    TestCBridgeFacet internal cBridge;
    CBridgeFacet.CBridgeData internal cBridgeData;

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.startBridgeTokensViaCBridge{ value: bridgeData.minAmount }(bridgeData, cBridgeData);
        } else {
            cBridge.startBridgeTokensViaCBridge(bridgeData, cBridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.swapAndStartBridgeTokensViaCBridge{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData,
                cBridgeData
            );
        } else {
            cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, cBridgeData);
        }
    }

    function setUp() public {
        initTestBase();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER), IMessageBus(CBRIDGE_MESSAGEBUS_ETH));
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge.swapAndStartBridgeTokensViaCBridge.selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;
        functionSelectors[4] = cBridge.executeMessageWithTransferRefund.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = TestCBridgeFacet(address(diamond));
        cBridge.addDex(address(uniswap));
        cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        cBridge.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);
        cBridge.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(cBridge), "cBridgeFacet");
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

    function testFail_ReentrantCallBridge() internal {
        // prepare bridge data for native bridging
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(cBridge.startBridgeTokensViaCBridge.selector, bridgeData, cBridgeData)
        );
    }

    function testRevert_ReentrantCallBridgeAndSwap() public {
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
                    address(cBridge),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                cBridge.swapAndStartBridgeTokensViaCBridge.selector,
                bridgeData,
                swapData,
                cBridgeData
            )
        );
    }

    function testRevert_WillRevertIfNotEnoughMsgValue() public {
        vm.startPrank(USER_SENDER);
        // prepare bridgeData
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        vm.expectRevert(InvalidAmount.selector);

        cBridge.startBridgeTokensViaCBridge{ value: bridgeData.minAmount - 1 }(bridgeData, cBridgeData);

        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
