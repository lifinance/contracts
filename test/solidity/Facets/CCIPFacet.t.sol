// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";
import { IRouterClient } from "@chainlink-ccip/v0.8/ccip/interfaces/IRouterClient.sol";

// Stub CCIPFacet Contract
contract TestCCIPFacet is CCIPFacet {
    constructor(IRouterClient _routerClient) CCIPFacet(_routerClient) {}

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
    IRouterClient internal ROUTER_CLIENT =
        IRouterClient(0x9527E2d01A3064ef6b50c1Da1C0cC523803BCFF2);

    function setUp() public {
        customBlockNumberForForking = 32915829;
        initTestBase();

        ccipFacet = new TestCCIPFacet(ROUTER_CLIENT);
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
        validCCIPData = CCIPFacet.CCIPData({ callData: "", extraArgs: "" });
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
