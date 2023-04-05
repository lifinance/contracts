// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { HyphenFacet } from "lifi/Facets/HyphenFacet.sol";
import { IHyphenRouter } from "lifi/Interfaces/IHyphenRouter.sol";

// Stub HyphenFacet Contract
contract TestHyphenFacet is HyphenFacet {
    constructor(IHyphenRouter _router) HyphenFacet(_router) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HyphenFacetTest is TestBaseFacet {
    // These values are for Polygon
    address internal constant HYPHEN_ROUTER =
        0x2A5c2568b10A0E826BfA892Cf21BA7218310180b;
    // -----

    TestHyphenFacet internal hyphenFacet;

    function setUp() public {
        initTestBase();

        hyphenFacet = new TestHyphenFacet(IHyphenRouter(HYPHEN_ROUTER));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = hyphenFacet.startBridgeTokensViaHyphen.selector;
        functionSelectors[1] = hyphenFacet
            .swapAndStartBridgeTokensViaHyphen
            .selector;
        functionSelectors[2] = hyphenFacet.addDex.selector;
        functionSelectors[3] = hyphenFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(hyphenFacet), functionSelectors);

        hyphenFacet = TestHyphenFacet(address(diamond));

        hyphenFacet.addDex(address(uniswap));
        hyphenFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        hyphenFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(hyphenFacet), "HyphenFacet");

        bridgeData.bridge = "hyphen";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hyphenFacet.startBridgeTokensViaHyphen{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            hyphenFacet.startBridgeTokensViaHyphen(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            hyphenFacet.swapAndStartBridgeTokensViaHyphen{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            hyphenFacet.swapAndStartBridgeTokensViaHyphen(
                bridgeData,
                swapData
            );
        }
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 10 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }
}
