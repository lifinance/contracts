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

contract CBridgeFacetTestOptimized is TestBase {
    address internal constant CBRIDGE_ROUTER = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    TestCBridgeFacet internal cBridge;

    function initiateBridgeTxWithFacet() internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, currentTxId++);

        // b) call the correct function selectors (as they differ for each facet)
        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
    }

    function initiateSwapAndBridgeTxWithFacet() internal override {
        // a) prepare the facet-specific data
        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, currentTxId);

        // b) call the correct function selectors (as they differ for each facet)
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
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
        setFacetAddressInTestBase(address(cBridge));
    }

    function testRunDefaultTests() public override {
        runDefaultTests();
    }
}
