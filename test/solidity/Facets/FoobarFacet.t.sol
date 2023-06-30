// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { FoobarFacet } from "lifi/Facets/FoobarFacet.sol";

// Stub FoobarFacet Contract
contract TestFoobarFacet is FoobarFacet {
    constructor(address _example) FoobarFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract FoobarFacetTest is TestBaseFacet {
    FoobarFacet.FoobarData internal validFoobarData;
    TestFoobarFacet internal foobarFacet;

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        foobarFacet = new TestFoobarFacet(address(0xb33f));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = foobarFacet.startBridgeTokensViaFoobar.selector;
        functionSelectors[1] = foobarFacet
            .swapAndStartBridgeTokensViaFoobar
            .selector;
        functionSelectors[2] = foobarFacet.addDex.selector;
        functionSelectors[3] = foobarFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(foobarFacet), functionSelectors);
        foobarFacet = TestFoobarFacet(address(diamond));
        foobarFacet.addDex(ADDRESS_UNISWAP);
        foobarFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        foobarFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        foobarFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(foobarFacet), "FoobarFacet");

        // adjust bridgeData
        bridgeData.bridge = "foobar";
        bridgeData.destinationChainId = 137;

        // produce valid FoobarData
        validFoobarData = FoobarFacet.FoobarData({
            exampleParam: "foo bar baz"
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            foobarFacet.startBridgeTokensViaFoobar{
                value: bridgeData.minAmount
            }(bridgeData, validFoobarData);
        } else {
            foobarFacet.startBridgeTokensViaFoobar(
                bridgeData,
                validFoobarData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            foobarFacet.swapAndStartBridgeTokensViaFoobar{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validFoobarData);
        } else {
            foobarFacet.swapAndStartBridgeTokensViaFoobar(
                bridgeData,
                swapData,
                validFoobarData
            );
        }
    }
}
