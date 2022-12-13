// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, ERC20, UniswapV2Router02 } from "../utils/TestBase.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { IRootChainManager } from "lifi/Interfaces/IRootChainManager.sol";

import { PolygonBridgeFacetOptimized } from "lifi/Facets/PolygonBridgeFacetOptimized.sol";
import { PolygonBridgeFacetStandalone } from "lifi/Facets/PolygonBridgeFacetStandalone.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub PolygonBridgeFacet Contract
contract TestPolygonBridgeFacet is PolygonBridgeFacet {
    constructor(IRootChainManager _rootChainManager, address _erc20Predicate)
        PolygonBridgeFacet(_rootChainManager, _erc20Predicate)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract TestPolygonBridgeFacetOptimized is PolygonBridgeFacetOptimized {
    constructor(IRootChainManager _rootChainManager, address _erc20Predicate)
        PolygonBridgeFacetOptimized(_rootChainManager, _erc20Predicate)
    {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract PolygonBridgeFacetTestCompare is TestBase {
    // EVENTS
    // event HopBridgeRegistered(address indexed assetId, address bridge);
    // event HopInitialized(PolygonBridgeFacet.Config[] configs);

    // These values are for Mainnet
    address internal constant ROOT_CHAIN_MANAGER = 0xA0c68C638235ee32657e8f720a23ceC1bFc77C77;
    address internal constant ERC20_PREDICATE = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;
    // -----

    TestPolygonBridgeFacet internal polygonBridgeFacet;
    TestPolygonBridgeFacetOptimized internal polygonBridgeFacetOptimized;
    PolygonBridgeFacetStandalone internal polygonBridgeFacetStandalone;
    ILiFi.BridgeData internal validBridgeData;

    function setUp() public {
        //! 1) set up original facet with diamond
        initTestBase();
        polygonBridgeFacet = new TestPolygonBridgeFacet(IRootChainManager(ROOT_CHAIN_MANAGER), ERC20_PREDICATE);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = polygonBridgeFacet.startBridgeTokensViaPolygonBridge.selector;
        functionSelectors[1] = polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge.selector;
        functionSelectors[2] = polygonBridgeFacet.addDex.selector;
        functionSelectors[3] = polygonBridgeFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(polygonBridgeFacet), functionSelectors);

        polygonBridgeFacet = TestPolygonBridgeFacet(address(diamond));

        polygonBridgeFacet.addDex(address(uniswap));
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        setFacetAddressInTestBase(address(polygonBridgeFacet), "PolygonBridgeFacet");

        // adjust bridgeData
        bridgeData.bridge = "polygon";

        //! 2) set up optimized facet with diamond
        diamond = createDiamond();

        polygonBridgeFacetOptimized = new TestPolygonBridgeFacetOptimized(
            IRootChainManager(ROOT_CHAIN_MANAGER),
            ERC20_PREDICATE
        );
        bytes4[] memory functionSelectors2 = new bytes4[](6);
        functionSelectors2[0] = polygonBridgeFacetOptimized.startBridgeTokensViaPolygonBridge.selector;
        functionSelectors2[1] = polygonBridgeFacetOptimized.swapAndStartBridgeTokensViaPolygonBridge.selector;
        functionSelectors2[4] = polygonBridgeFacetOptimized.addDex.selector;
        functionSelectors2[5] = polygonBridgeFacetOptimized.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(polygonBridgeFacetOptimized), functionSelectors);

        polygonBridgeFacetOptimized = TestPolygonBridgeFacetOptimized(address(diamond));

        polygonBridgeFacet.addDex(address(uniswap));
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        polygonBridgeFacet.setFunctionApprovalBySignature(uniswap.swapTokensForExactETH.selector);

        //! 3) deploy gas-optimized standalone hop facet
        polygonBridgeFacetStandalone = new PolygonBridgeFacetStandalone(
            IRootChainManager(ROOT_CHAIN_MANAGER),
            ERC20_PREDICATE
        );
    }

    function test_bridgeTokens_1_STANDARD() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(polygonBridgeFacet), bridgeData.minAmount);

        uint256 startGas = gasleft();
        polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);
        vm.writeLine(logFilePath, string.concat("Gas used STANDARD:   ", vm.toString(startGas - gasleft())));

        vm.stopPrank();
    }

    function test_bridgeTokens_2_OPTIMIZED() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(polygonBridgeFacetOptimized), bridgeData.minAmount);
        uint256 startGas = gasleft();
        polygonBridgeFacetOptimized.startBridgeTokensViaPolygonBridge(bridgeData);
        vm.writeLine(logFilePath, string.concat("Gas used OPTIMIZED:  ", vm.toString(startGas - gasleft())));
        vm.stopPrank();
    }

    function test_bridgeTokens_3_STANDALONE() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(address(polygonBridgeFacetStandalone), bridgeData.minAmount);
        uint256 startGas = gasleft();
        polygonBridgeFacetStandalone.startBridgeTokensViaPolygonBridge(bridgeData);
        vm.writeLine(logFilePath, string.concat("Gas used STANDALONE: ", vm.toString(startGas - gasleft())));
        vm.stopPrank();
    }
}
