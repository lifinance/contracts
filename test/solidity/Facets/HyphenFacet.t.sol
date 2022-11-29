// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console, InvalidAmount, ERC20 } from "../utils/TestBase.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InsufficientBalance, InvalidDestinationChain, NoSwapDataProvided } from "src/Errors/GenericErrors.sol";
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

contract HyphenFacetTest is TestBase {
    // These values are for Polygon
    address internal constant USDC_ADDRESS = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address internal constant USDC_HOLDER = 0xD6216fC19DB775Df9774a6E33526131dA7D19a2c;
    address internal constant WMATIC_ADDRESS = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address internal constant WMATIC_HOLDER = 0x01aeFAC4A308FbAeD977648361fBAecFBCd380C7;
    address internal constant HYPHEN_ROUTER = 0x2A5c2568b10A0E826BfA892Cf21BA7218310180b;
    address internal constant UNISWAP_V2_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    // -----

    TestHyphenFacet internal hyphenFacet;

    function setUp() public {
        initTestBase();

        diamond = createDiamond();
        hyphenFacet = new TestHyphenFacet(IHyphenRouter(HYPHEN_ROUTER));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = hyphenFacet.startBridgeTokensViaHyphen.selector;
        functionSelectors[1] = hyphenFacet.swapAndStartBridgeTokensViaHyphen.selector;
        functionSelectors[2] = hyphenFacet.addDex.selector;
        functionSelectors[3] = hyphenFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hyphenFacet), functionSelectors);

        hyphenFacet = TestHyphenFacet(address(diamond));

        hyphenFacet.addDex(address(uniswap));
        hyphenFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hyphenFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);

        setFacetAddressInTestBase(address(hyphenFacet));

        bridgeData.bridge = "hyphen";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hyphenFacet.startBridgeTokensViaHyphen{ value: bridgeData.minAmount }(bridgeData);
        } else {
            hyphenFacet.startBridgeTokensViaHyphen(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hyphenFacet.swapAndStartBridgeTokensViaHyphen{ value: swapData[0].fromAmount }(bridgeData, swapData);
        } else {
            hyphenFacet.swapAndStartBridgeTokensViaHyphen(bridgeData, swapData);
        }
    }
}
