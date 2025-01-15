// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";

// Stub GlacisFacet Contract
contract TestGlacisFacet is GlacisFacet {
    constructor(address _example) GlacisFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GlacisFacetTest is TestBaseFacet {
    GlacisFacet.GlacisData internal validGlacisData;
    TestGlacisFacet internal glacisFacet;
    address internal EXAMPLE_PARAM = address(0xb33f);

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        glacisFacet = new TestGlacisFacet(EXAMPLE_PARAM);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = glacisFacet.startBridgeTokensViaGlacis.selector;
        functionSelectors[1] = glacisFacet
            .swapAndStartBridgeTokensViaGlacis
            .selector;
        functionSelectors[2] = glacisFacet.addDex.selector;
        functionSelectors[3] = glacisFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(glacisFacet), functionSelectors);
        glacisFacet = TestGlacisFacet(address(diamond));
        glacisFacet.addDex(ADDRESS_UNISWAP);
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        glacisFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(glacisFacet), "GlacisFacet");

        // adjust bridgeData
        bridgeData.bridge = "glacis";
        bridgeData.destinationChainId = 137;

        // produce valid GlacisData
        validGlacisData = GlacisFacet.GlacisData({
            refundAddress: USER_REFUND
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
            glacisFacet.startBridgeTokensViaGlacis{
                value: bridgeData.minAmount
            }(bridgeData, validGlacisData);
        } else {
            glacisFacet.startBridgeTokensViaGlacis(
                bridgeData,
                validGlacisData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            glacisFacet.swapAndStartBridgeTokensViaGlacis{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validGlacisData);
        } else {
            glacisFacet.swapAndStartBridgeTokensViaGlacis(
                bridgeData,
                swapData,
                validGlacisData
            );
        }
    }
}
