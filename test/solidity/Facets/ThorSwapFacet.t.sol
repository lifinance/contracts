// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ThorSwapFacet } from "lifi/Facets/ThorSwapFacet.sol";
import { IThorSwap } from "lifi/Interfaces/IThorSwap.sol";

// Stub ThorSwapFacet Contract
contract TestThorSwapFacet is ThorSwapFacet {
    constructor(address _tsTokenProxy) ThorSwapFacet(_tsTokenProxy) {}

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
    address internal constant UNI_AGGREGATOR =
        0x86904Eb2b3c743400D03f929F2246EfA80B91215;
    address internal constant GENERIC_AGGREGTOR =
        0xd31f7e39afECEc4855fecc51b693F9A0Cec49fd2;
    address internal constant TOKEN_PROXY =
        0xF892Fef9dA200d9E84c9b0647ecFF0F34633aBe8;

    ThorSwapFacet.ThorSwapData internal validThorSwapData;
    TestThorSwapFacet internal thorSwapFacet;

    function setUp() public {
        customBlockNumberForForking = 16661275;
        initTestBase();

        thorSwapFacet = new TestThorSwapFacet(TOKEN_PROXY);
        bytes4[] memory functionSelectors = new bytes4[](5);
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
        functionSelectors[4] = thorSwapFacet.initThorSwap.selector;

        addFacet(diamond, address(thorSwapFacet), functionSelectors);
        thorSwapFacet = TestThorSwapFacet(address(diamond));

        IThorSwap[] memory allowedRouters = new IThorSwap[](3);
        allowedRouters[0] = IThorSwap(THORCHAIN_ROUTER);
        allowedRouters[1] = IThorSwap(UNI_AGGREGATOR);
        allowedRouters[2] = IThorSwap(GENERIC_AGGREGTOR);

        thorSwapFacet.initThorSwap(allowedRouters);
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
        bridgeData.destinationChainId = 0;

        // set valid ThorSwapData
        validThorSwapData = ThorSwapFacet.ThorSwapData(
            ThorSwapFacet.RouterType.Uniswap,
            UNI_AGGREGATOR,
            THORCHAIN_ROUTER,
            0xeFa100c7821e68765b074dFF0670ae4F516181ee,
            "=:BTC.BTC:bc1qr930z62t42mnqy25h2tgcu7knpngjtxld33maa:10808311:t:15",
            ADDRESS_USDC,
            bridgeData.minAmount,
            bridgeData.minAmount,
            address(0),
            "",
            block.timestamp + 20 minutes
        );

        vm.label(UNI_AGGREGATOR, "UNI_AGGREGATOR");
        vm.label(THORCHAIN_ROUTER, "THORCHAIN_ROUTER");
        vm.label(GENERIC_AGGREGTOR, "GENERIC_AGGREGTOR");
        vm.label(TOKEN_PROXY, "TOKEN_PROXY");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            validThorSwapData.routerType = ThorSwapFacet.RouterType.Thorchain;
            validThorSwapData.tsRouter = THORCHAIN_ROUTER;
            validThorSwapData.token = address(0);

            thorSwapFacet.startBridgeTokensViaThorSwap{
                value: bridgeData.minAmount
            }(bridgeData, validThorSwapData);
        } else {
            validThorSwapData.amount = bridgeData.minAmount;
            validThorSwapData.amountOutMin = bridgeData.minAmount;
            thorSwapFacet.startBridgeTokensViaThorSwap(
                bridgeData,
                validThorSwapData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (bridgeData.sendingAssetId == address(0)) {
            validThorSwapData.routerType = ThorSwapFacet.RouterType.Thorchain;
            validThorSwapData.tsRouter = THORCHAIN_ROUTER;
            validThorSwapData.token = address(0);

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
