// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { IRootChainManager } from "lifi/Interfaces/IRootChainManager.sol";

// Stub PolygonBridgeFacet Contract
contract TestPolygonBridgeFacet is PolygonBridgeFacet {
    constructor(
        IRootChainManager _rootChainManager,
        address _erc20Predicate
    ) PolygonBridgeFacet(_rootChainManager, _erc20Predicate) {}

    function addToWhitelist(address _address) external {
        LibAllowList.addAllowedContract(_address);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract PolygonBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant ROOT_CHAIN_MANAGER =
        0xA0c68C638235ee32657e8f720a23ceC1bFc77C77;
    address internal constant ERC20_PREDICATE =
        0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;

    // -----

    TestPolygonBridgeFacet internal polygonBridgeFacet;

    function setUp() public {
        initTestBase();

        polygonBridgeFacet = new TestPolygonBridgeFacet(
            IRootChainManager(ROOT_CHAIN_MANAGER),
            ERC20_PREDICATE
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = polygonBridgeFacet
            .startBridgeTokensViaPolygonBridge
            .selector;
        functionSelectors[1] = polygonBridgeFacet
            .swapAndStartBridgeTokensViaPolygonBridge
            .selector;
        functionSelectors[2] = polygonBridgeFacet.addToWhitelist.selector;
        functionSelectors[3] = polygonBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(polygonBridgeFacet), functionSelectors);

        polygonBridgeFacet = TestPolygonBridgeFacet(address(diamond));

        polygonBridgeFacet.addToWhitelist(address(uniswap));
        polygonBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        polygonBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(
            address(polygonBridgeFacet),
            "PolygonBridgeFacet"
        );

        bridgeData.bridge = "polygon";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            polygonBridgeFacet.startBridgeTokensViaPolygonBridge{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            polygonBridgeFacet.startBridgeTokensViaPolygonBridge(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            polygonBridgeFacet.swapAndStartBridgeTokensViaPolygonBridge(
                bridgeData,
                swapData
            );
        }
    }
}
