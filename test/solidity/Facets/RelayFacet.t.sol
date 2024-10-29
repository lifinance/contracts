// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";

// Stub RelayFacet Contract
contract TestRelayFacet is RelayFacet {
    constructor(address _example) RelayFacet(_example, _example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract RelayFacetTest is TestBaseFacet {
    RelayFacet.RelayData internal validRelayData;
    TestRelayFacet internal relayFacet;
    address internal EXAMPLE_PARAM = address(0xb33f);

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        relayFacet = new TestRelayFacet(EXAMPLE_PARAM);
        // relayFacet.initRelay(EXAMPLE_ALLOWED_TOKENS);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = relayFacet.startBridgeTokensViaRelay.selector;
        functionSelectors[1] = relayFacet
            .swapAndStartBridgeTokensViaRelay
            .selector;
        functionSelectors[2] = relayFacet.addDex.selector;
        functionSelectors[3] = relayFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(relayFacet), functionSelectors);
        relayFacet = TestRelayFacet(address(diamond));
        relayFacet.addDex(ADDRESS_UNISWAP);
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(relayFacet), "RelayFacet");

        // adjust bridgeData
        bridgeData.bridge = "relay";
        bridgeData.destinationChainId = 137;

        // produce valid RelayData
        // validRelayData = RelayFacet.RelayData({ exampleParam: "foo bar baz" });
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
            relayFacet.startBridgeTokensViaRelay{
                value: bridgeData.minAmount
            }(bridgeData, validRelayData);
        } else {
            relayFacet.startBridgeTokensViaRelay(bridgeData, validRelayData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            relayFacet.swapAndStartBridgeTokensViaRelay{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validRelayData);
        } else {
            relayFacet.swapAndStartBridgeTokensViaRelay(
                bridgeData,
                swapData,
                validRelayData
            );
        }
    }
}
