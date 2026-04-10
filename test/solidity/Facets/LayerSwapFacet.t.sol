// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub LayerSwapFacet Contract
contract TestLayerSwapFacet is LayerSwapFacet, TestWhitelistManagerBase {
    constructor(
        address _layerSwapTarget
    ) LayerSwapFacet(_layerSwapTarget) {}
}

contract LayerSwapFacetTest is TestBaseFacet {
    LayerSwapFacet.LayerSwapData internal validLayerSwapData;
    TestLayerSwapFacet internal layerSwapFacet;
    address internal LAYERSWAP_TARGET = address(0xb33f);

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        layerSwapFacet = new TestLayerSwapFacet(LAYERSWAP_TARGET);
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = layerSwapFacet
            .startBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[1] = layerSwapFacet
            .swapAndStartBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[2] = layerSwapFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = layerSwapFacet
            .removeAllowedContractSelector
            .selector;
        functionSelectors[4] = layerSwapFacet.consumedIds.selector;

        addFacet(diamond, address(layerSwapFacet), functionSelectors);
        layerSwapFacet = TestLayerSwapFacet(address(diamond));
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        layerSwapFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(layerSwapFacet),
            "LayerSwapFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "layerswap";
        bridgeData.destinationChainId = 137;

        // produce valid LayerSwapData
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            requestId: bytes32(keccak256("testRequestId")),
            nonEVMReceiver: bytes32(0)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            layerSwapFacet.startBridgeTokensViaLayerSwap{
                value: bridgeData.minAmount
            }(bridgeData, validLayerSwapData);
        } else {
            layerSwapFacet.startBridgeTokensViaLayerSwap(
                bridgeData,
                validLayerSwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validLayerSwapData);
        } else {
            layerSwapFacet.swapAndStartBridgeTokensViaLayerSwap(
                bridgeData,
                swapData,
                validLayerSwapData
            );
        }
    }
}
