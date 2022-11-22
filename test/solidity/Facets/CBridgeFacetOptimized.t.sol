// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console } from "../utils/TestBase.sol";
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

contract CBridgeFacetTestOptimized is TestBase {
    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    TestCBridgeFacet internal cBridge;

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, currentTxId++);

        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.startBridgeTokensViaCBridge{ value: bridgeData.minAmount }(bridgeData, data);
        } else {
            cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, currentTxId++);

        // b) call the correct function selectors (as they differ for each facet)
        if (isNative) {
            cBridge.swapAndStartBridgeTokensViaCBridge{ value: bridgeData.minAmount }(bridgeData, swapData, data);
        } else {
            cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        }
    }

    function setUp() public {
        initTestBase();
        cBridge = new TestCBridgeFacet(ICBridge(CBRIDGE_ROUTER));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = cBridge.startBridgeTokensViaCBridge.selector;
        functionSelectors[1] = cBridge.swapAndStartBridgeTokensViaCBridge.selector;
        functionSelectors[2] = cBridge.addDex.selector;
        functionSelectors[3] = cBridge.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(cBridge), functionSelectors);

        cBridge = TestCBridgeFacet(address(diamond));
        cBridge.addDex(address(uniswap));
        cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForETH.selector);
        setFacetAddressInTestBase(address(cBridge));
    }

    function testFailReentrantCallBridge() public {
        // prepare facet-specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData(5000, currentTxId++);

        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(cBridge.startBridgeTokensViaCBridge.selector, bridgeData, cBridgeData)
        );
    }

    function testFailReentrantCallBridgeAndSwap() internal {
        // prepare facet-specific data
        CBridgeFacet.CBridgeData memory cBridgeData = CBridgeFacet.CBridgeData(5000, currentTxId++);
        // prepare bridge data for native bridging

        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

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

    function testFailWillRevertIfnNotEnoughMsgValue() public {
        vm.startPrank(USER_USDC_WHALE);
        // prepare bridgeData
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, currentTxId++);

        cBridge.swapAndStartBridgeTokensViaCBridge{ value: bridgeData.minAmount - 1 }(bridgeData, swapData, data);

        vm.stopPrank();
    }
}
