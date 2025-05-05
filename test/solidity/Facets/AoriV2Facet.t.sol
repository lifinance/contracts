// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.29;

import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { AoriV2Facet } from "lifi/Facets/AoriV2Facet.sol";

// Stub AoriV2Facet Contract
contract TestAoriV2Facet is AoriV2Facet {
    constructor(address _example) AoriV2Facet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract AoriV2FacetTest is TestBaseFacet {
    AoriV2Facet.AoriV2Data internal validAoriData;
    TestAoriV2Facet internal aoriFacet;
    address internal EXAMPLE_PARAM = address(0xb33f);

    function setUp() public {
        // solhint-disable-next-line var-name-mixedcase
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        aoriFacet = new TestAoriV2Facet(EXAMPLE_PARAM);
        aoriFacet.initAoriV2(EXAMPLE_ALLOWED_TOKENS);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = aoriFacet.startBridgeTokensViaAoriV2.selector;
        functionSelectors[1] = aoriFacet
            .swapAndStartBridgeTokensViaAoriV2
            .selector;
        functionSelectors[2] = aoriFacet.addDex.selector;
        functionSelectors[3] = aoriFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(aoriFacet), functionSelectors);
        aoriFacet = TestAoriV2Facet(address(diamond));
        aoriFacet.addDex(ADDRESS_UNISWAP);
        aoriFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        aoriFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        aoriFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(aoriFacet), "AoriV2Facet");

        // adjust bridgeData
        bridgeData.bridge = "aoriV2";
        bridgeData.destinationChainId = 137;

        // produce valid AoriV2Data
        validAoriData = AoriV2Facet.AoriV2Data({
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
            aoriFacet.startBridgeTokensViaAoriV2{
                value: bridgeData.minAmount
            }(bridgeData, validAoriData);
        } else {
            aoriFacet.startBridgeTokensViaAoriV2(bridgeData, validAoriData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            aoriFacet.swapAndStartBridgeTokensViaAoriV2{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validAoriData);
        } else {
            aoriFacet.swapAndStartBridgeTokensViaAoriV2(
                bridgeData,
                swapData,
                validAoriData
            );
        }
    }
}
