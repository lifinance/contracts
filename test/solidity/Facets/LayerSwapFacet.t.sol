// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { LayerSwapFacet } from "lifi/Facets/LayerSwapFacet.sol";

// Stub LayerSwapFacet Contract
contract TestLayerSwapFacet is LayerSwapFacet {
    constructor(
        address _example
    ) LayerSwapFacet(_example) {}

    function addToWhitelist(address _contractAddress) external {
        LibAllowList.addAllowedContract(_contractAddress);
    }

    function setFunctionWhitelistBySelector(bytes4 _selector) external {
        LibAllowList.addAllowedSelector(_selector);
    }
}

contract LayerSwapFacetTest is TestBaseFacet {
    LayerSwapFacet.LayerSwapData internal validLayerSwapData;
    TestLayerSwapFacet internal layerSwapFacet;
    address internal EXAMPLE_PARAM = address(0xb33f);


    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        layerSwapFacet = new TestLayerSwapFacet(EXAMPLE_PARAM);
        layerSwapFacet.initLayerSwap(EXAMPLE_ALLOWED_TOKENS);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = layerSwapFacet.startBridgeTokensViaLayerSwap.selector;
        functionSelectors[1] = layerSwapFacet
            .swapAndStartBridgeTokensViaLayerSwap
            .selector;
        functionSelectors[2] = layerSwapFacet.addToWhitelist.selector;
        functionSelectors[3] = layerSwapFacet
            .setFunctionWhitelistBySelector
            .selector;

        addFacet(diamond, address(layerSwapFacet), functionSelectors);
        layerSwapFacet = TestLayerSwapFacet(address(diamond));
        layerSwapFacet.addToWhitelist(ADDRESS_UNISWAP);
        layerSwapFacet.setFunctionWhitelistBySelector(
            uniswap.swapExactTokensForTokens.selector
        );
        layerSwapFacet.setFunctionWhitelistBySelector(
            uniswap.swapTokensForExactETH.selector
        );
        layerSwapFacet.setFunctionWhitelistBySelector(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(layerSwapFacet), "LayerSwapFacet");

        // adjust bridgeData
        bridgeData.bridge = "layerSwap";
        bridgeData.destinationChainId = 137;

        // produce valid LayerSwapData
        validLayerSwapData = LayerSwapFacet.LayerSwapData({
            exampleParam: "foo bar baz"
        });
    }

    // All facet test files inherit from `utils/TestBaseFacet.sol` and require the following method overrides:
    // - function initiateBridgeTxWithFacet(bool isNative)
    // - function initiateSwapAndBridgeTxWithFacet(bool isNative)
    //
    // These methods are used to run the following tests which must pass:
    // - testBase_CanBridgeNativeTokens()
    // - testBase_CanBridgeTokens()
    // - testBase_CanBridgeTokens_fuzzed(uint256)
    // - testBase_CanSwapAndBridgeNativeTokens()
    // - testBase_CanSwapAndBridgeTokens()
    // - testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
    // - testBase_Revert_BridgeToSameChainId()
    // - testBase_Revert_BridgeWithInvalidAmount()
    // - testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    // - testBase_Revert_BridgeWithInvalidReceiverAddress()
    // - testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
    // - testBase_Revert_CallerHasInsufficientFunds()
    // - testBase_Revert_SwapAndBridgeToSameChainId()
    // - testBase_Revert_SwapAndBridgeWithInvalidAmount()
    // - testBase_Revert_SwapAndBridgeWithInvalidSwapData()
    // 
    // In some cases it doesn't make sense to have all tests. For example the bridge may not support native tokens.
    // In that case you can override the test method and leave it empty. For example:
    // 
    // function testBase_CanBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }
    // 
    // function testBase_CanSwapAndBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }

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
