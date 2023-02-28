// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { SquidFacet } from "lifi/Facets/SquidFacet.sol";
import { ISquidRouter } from "lifi/Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "lifi/Interfaces/ISquidMulticall.sol";

// Stub SquidFacet Contract
contract TestSquidFacet is SquidFacet {
    address internal constant ADDRESS_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    constructor(ISquidRouter _squidRouter) SquidFacet(_squidRouter) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract SquidFacetTest is TestBaseFacet {
    // These values are for Optimism_Kovan
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SQUID_ROUTER =
        0x51b33C9cCceb447bDdd54fA10e244eE180F2170F;
    // -----
    SquidFacet.SquidData internal validSquidData;
    TestSquidFacet internal squidFacet;

    function setUp() public {
        initTestBase();

        squidFacet = new TestSquidFacet(ISquidRouter(SQUID_ROUTER));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = squidFacet.startBridgeTokensViaSquid.selector;
        functionSelectors[1] = squidFacet
            .swapAndStartBridgeTokensViaSquid
            .selector;
        functionSelectors[2] = squidFacet.addDex.selector;
        functionSelectors[3] = squidFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(squidFacet), functionSelectors);
        squidFacet = TestSquidFacet(address(diamond));
        squidFacet.addDex(ADDRESS_UNISWAP);
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        squidFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(squidFacet), "SquidFacet");

        // adjust bridgeData
        bridgeData.bridge = "squid router";
        bridgeData.destinationChainId = 137;

        // produce valid SquidData
        validSquidData = SquidFacet.SquidData({
            destinationChain: "Polygon",
            bridgedTokenSymbol: "USDC",
            refundRecipient: USER_SENDER,
            forecallEnabled: false
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            squidFacet.startBridgeTokensViaSquid{
                value: bridgeData.minAmount
            }(bridgeData, validSquidData);
        } else {
            squidFacet.startBridgeTokensViaSquid(bridgeData, validSquidData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        /* if (isNative) { */
        /*     squidFacet.swapAndStartBridgeTokensViaSquid{ */
        /*         value: swapData[0].fromAmount */
        /*     }(bridgeData, swapData, validSquidData); */
        /* } else { */
        /*     squidFacet.swapAndStartBridgeTokensViaSquid( */
        /*         bridgeData, */
        /*         swapData, */
        /*         validSquidData */
        /*     ); */
        /* } */
    }
}
