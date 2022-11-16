// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, TestBase } from "../utils/TestBase.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ICBridge } from "lifi/Interfaces/ICBridge.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";

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
    }

    function testCanBridgeTokens() public {
        vm.startPrank(USER_USDC_WHALE);
        usdc.approve(address(cBridge), 10_000 * 10**usdc.decimals());
        ILiFi.BridgeData memory bridgeData = getDefaultBridgeData();

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, 1);

        cBridge.startBridgeTokensViaCBridge(bridgeData, data);
        vm.stopPrank();
    }

    function testCanSwapAndBridgeTokens() public {
        vm.startPrank(USER_DAI_WHALE);

        ILiFi.BridgeData memory bridgeData = getDefaultBridgeData();
        bridgeData.hasSourceSwaps = true;

        LibSwap.SwapData[] memory swapData = getDefaultSwapDataSingleDAItoUSDC(address(cBridge));

        CBridgeFacet.CBridgeData memory data = CBridgeFacet.CBridgeData(5000, 1);

        // Approve DAI
        dai.approve(address(cBridge), swapData[0].fromAmount);
        cBridge.swapAndStartBridgeTokensViaCBridge(bridgeData, swapData, data);
        vm.stopPrank();
    }
}
