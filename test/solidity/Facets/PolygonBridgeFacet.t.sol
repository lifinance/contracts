// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, InvalidAmount, ERC20 } from "../utils/TestBaseFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InsufficientBalance, InvalidDestinationChain, NoSwapDataProvided } from "src/Errors/GenericErrors.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { IRootChainManager } from "lifi/Interfaces/IRootChainManager.sol";

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

contract PolygonBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant ROOT_CHAIN_MANAGER = 0xA0c68C638235ee32657e8f720a23ceC1bFc77C77;
    address internal constant ERC20_PREDICATE = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;

    // -----

    TestPolygonBridgeFacet internal polygonBridgeFacet;

    function setUp() public {
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

        bridgeData.bridge = "polygon";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            polygonBridgeFacet.startBridgeTokensViaPolygonBridge{ value: bridgeData.minAmount }(bridgeData);
        } else {
            polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge{ value: swapData[0].fromAmount }(
                bridgeData,
                swapData
            );
        } else {
            polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge(bridgeData, swapData);
        }
    }
}
