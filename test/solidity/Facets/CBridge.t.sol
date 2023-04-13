// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount } from "../utils/TestBaseFacet.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";

// Stub CBridgeFacet Contract
contract TestCBridgeFacet is CBridgeFacet {
    constructor(ICBridge _cBridge) CBridgeFacet(_cBridge) {}

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
    address internal constant CBRIDGE_ROUTER =
        0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    TestCBridgeFacet internal cBridge;

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            currentTxId++
        );

        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.startBridgeTokensViaCBridge{ value: bridgeData.minAmount }(
                bridgeData,
                data
            );
        } else {
            cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            currentTxId++
        );

        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.swapAndStartBridgeTokensViaCBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, data);
        } else {
            cBridge.swapAndStartBridgeTokensViaCBridge(
                bridgeData,
                swapData,
                data
            );
        }
    }

    function setUp() public {
        initTestBase();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge
            .swapAndStartBridgeTokensViaCBridge
            .selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = TestCBridgeFacet(address(diamond));
        cBridge.addDex(address(uniswap));
        cBridge.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        cBridge.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        cBridge.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        setFacetAddressInTestBase(address(cBridge), "cBridgeFacet");
    }

    function testFail_ReentrantCallBridge() internal {
        // prepare facet-specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData(
            5000,
            currentTxId++
        );

        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                cBridge.startBridgeTokensViaCBridge.selector,
                bridgeData,
                cBridgeData
            )
        );
    }

    function testRevert_ReentrantCallBridgeAndSwap() public {
        vm.startPrank(USER_SENDER);

        // prepare facet-specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData(
            5000,
            currentTxId++
        );

        // prepare bridge data for native bridging
        setDefaultBridgeData();
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
        vm.startPrank(USER_USDC_WHALE);
        // prepare bridgeData
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(
            5000,
            currentTxId++
        );

        vm.expectRevert(InvalidAmount.selector);

        cBridge.startBridgeTokensViaCBridge{ value: bridgeData.minAmount - 1 }(
            bridgeData,
            data
        );

        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
