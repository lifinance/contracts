// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";
import { IDlnSource } from "lifi/Interfaces/IDlnSource.sol";

// Stub DeBridgeDlnFacet Contract
contract TestDeBridgeDlnFacet is DeBridgeDlnFacet {
    constructor(IDlnSource _example) DeBridgeDlnFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract DeBridgeDlnFacetTest is TestBaseFacet {
    DeBridgeDlnFacet.DeBridgeDlnData internal validDeBridgeDlnData;
    TestDeBridgeDlnFacet internal deBridgeDlnFacet;
    IDlnSource internal EXAMPLE_PARAM = IDlnSource(address(0xb33f));

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        deBridgeDlnFacet = new TestDeBridgeDlnFacet(EXAMPLE_PARAM);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = deBridgeDlnFacet
            .startBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[1] = deBridgeDlnFacet
            .swapAndStartBridgeTokensViaDeBridgeDln
            .selector;
        functionSelectors[2] = deBridgeDlnFacet.addDex.selector;
        functionSelectors[3] = deBridgeDlnFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(deBridgeDlnFacet), functionSelectors);
        deBridgeDlnFacet = TestDeBridgeDlnFacet(address(diamond));
        deBridgeDlnFacet.addDex(ADDRESS_UNISWAP);
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        deBridgeDlnFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(deBridgeDlnFacet),
            "DeBridgeDlnFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "deBridgeDln";
        bridgeData.destinationChainId = 137;

        // produce valid DeBridgeDlnData
        // validDeBridgeDlnData = DeBridgeDlnFacet.DeBridgeDlnData({
        //     exampleParam: "foo bar baz"
        // });
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
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln{
                value: bridgeData.minAmount
            }(bridgeData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.startBridgeTokensViaDeBridgeDln(
                bridgeData,
                validDeBridgeDlnData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validDeBridgeDlnData);
        } else {
            deBridgeDlnFacet.swapAndStartBridgeTokensViaDeBridgeDln(
                bridgeData,
                swapData,
                validDeBridgeDlnData
            );
        }
    }
}
