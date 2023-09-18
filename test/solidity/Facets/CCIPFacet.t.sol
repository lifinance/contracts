// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";

// Stub CCIPFacet Contract
contract TestCCIPFacet is CCIPFacet {
    constructor(address _example) CCIPFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract CCIPFacetTest is TestBaseFacet {
    CCIPFacet.CCIPData internal validCCIPData;
    TestCCIPFacet internal ccipFacet;
    address internal EXAMPLE_PARAM = address(0xb33f);

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        ccipFacet = new TestCCIPFacet(EXAMPLE_PARAM);
        ccipFacet.initCCIP(EXAMPLE_ALLOWED_TOKENS);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = ccipFacet.startBridgeTokensViaCCIP.selector;
        functionSelectors[1] = ccipFacet
            .swapAndStartBridgeTokensViaCCIP
            .selector;
        functionSelectors[2] = ccipFacet.addDex.selector;
        functionSelectors[3] = ccipFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(ccipFacet), functionSelectors);
        ccipFacet = TestCCIPFacet(address(diamond));
        ccipFacet.addDex(ADDRESS_UNISWAP);
        ccipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        ccipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        ccipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(ccipFacet), "CCIPFacet");

        // adjust bridgeData
        bridgeData.bridge = "ccip";
        bridgeData.destinationChainId = 137;

        // produce valid CCIPData
        validCCIPData = CCIPFacet.CCIPData({ exampleParam: "foo bar baz" });
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
            ccipFacet.startBridgeTokensViaCCIP{ value: bridgeData.minAmount }(
                bridgeData,
                validCCIPData
            );
        } else {
            ccipFacet.startBridgeTokensViaCCIP(bridgeData, validCCIPData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            ccipFacet.swapAndStartBridgeTokensViaCCIP{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validCCIPData);
        } else {
            ccipFacet.swapAndStartBridgeTokensViaCCIP(
                bridgeData,
                swapData,
                validCCIPData
            );
        }
    }
}
