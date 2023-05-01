// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { ThorSwapFacet } from "lifi/Facets/ThorSwapFacet.sol";
import { IThorSwap } from "lifi/Interfaces/IThorSwap.sol";

// Stub ThorSwapFacet Contract
contract TestThorSwapFacet is ThorSwapFacet {
    constructor(address _thorchainRouter) ThorSwapFacet(_thorchainRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ThorSwapFacetTest is TestBaseFacet {
    address internal constant THORCHAIN_ROUTER =
        0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146;

    ThorSwapFacet.ThorSwapData internal validThorSwapData;
    TestThorSwapFacet internal thorSwapFacet;

    function setUp() public {
        customBlockNumberForForking = 16661275;
        initTestBase();

        thorSwapFacet = new TestThorSwapFacet(THORCHAIN_ROUTER);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = thorSwapFacet
            .startBridgeTokensViaThorSwap
            .selector;
        functionSelectors[1] = thorSwapFacet
            .swapAndStartBridgeTokensViaThorSwap
            .selector;
        functionSelectors[2] = thorSwapFacet.addDex.selector;
        functionSelectors[3] = thorSwapFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(thorSwapFacet), functionSelectors);
        thorSwapFacet = TestThorSwapFacet(address(diamond));

        thorSwapFacet.addDex(ADDRESS_UNISWAP);
        thorSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        thorSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        thorSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(thorSwapFacet), "ThorSwapFacet");

        // adjust bridgeData
        bridgeData.bridge = "thorswap";
        bridgeData.destinationChainId = 12121212;

        // set valid ThorSwapData
        validThorSwapData = ThorSwapFacet.ThorSwapData(
            0xeFa100c7821e68765b074dFF0670ae4F516181ee,
            "=:BTC.BTC:bc1qr930z62t42mnqy25h2tgcu7knpngjtxld33maa:10808311:t:15",
            block.timestamp + 60 minutes
        );

        vm.label(THORCHAIN_ROUTER, "THORCHAIN_ROUTER");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            thorSwapFacet.startBridgeTokensViaThorSwap{
                value: bridgeData.minAmount
            }(bridgeData, validThorSwapData);
        } else {
            thorSwapFacet.startBridgeTokensViaThorSwap(
                bridgeData,
                validThorSwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            thorSwapFacet.swapAndStartBridgeTokensViaThorSwap{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validThorSwapData);
        } else {
            thorSwapFacet.swapAndStartBridgeTokensViaThorSwap(
                bridgeData,
                swapData,
                validThorSwapData
            );
        }
    }
}
