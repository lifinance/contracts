// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
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
    // These values are for Ethereum Mainnet
    address internal constant ETH_HOLDER =
        0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511;
    address internal constant WETH_HOLDER =
        0xD022510A3414f255150Aa54b2e42DB6129a20d9E;
    address internal constant SQUID_ROUTER =
        0xce16F69375520ab01377ce7B88f5BA8C48F8D666;
    address internal constant SQUID_MULTICALL =
        0x4fd39C9E151e50580779bd04B1f7eCc310079fd3;
    // -----
    SquidFacet.SquidData internal validSquidData;
    TestSquidFacet internal squidFacet;

    function setUp() public {
        customBlockNumberForForking = 16724399;
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

        validSquidData.routeType = SquidFacet.RouteType.BridgeCall;
        validSquidData.destinationChain = "Polygon";
        validSquidData.bridgedTokenSymbol = "USDC";
        validSquidData.fee = 0;
        validSquidData.forecallEnabled = false;

        vm.label(SQUID_ROUTER, "SquidRouter");
        vm.label(SQUID_MULTICALL, "SquidMulticall");
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            SquidFacet.SquidData memory squidData = setNativeBridgeSquidData();

            squidFacet.startBridgeTokensViaSquid{
                value: bridgeData.minAmount
            }(bridgeData, squidData);
        } else {
            squidFacet.startBridgeTokensViaSquid(bridgeData, validSquidData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            SquidFacet.SquidData memory squidData = setNativeBridgeSquidData();

            squidFacet.swapAndStartBridgeTokensViaSquid{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, squidData);
        } else {
            squidFacet.swapAndStartBridgeTokensViaSquid(
                bridgeData,
                swapData,
                validSquidData
            );
        }
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 100_000);
        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function setNativeBridgeSquidData()
        internal
        view
        returns (SquidFacet.SquidData memory)
    {
        SquidFacet.SquidData memory squidData = validSquidData;

        ISquidMulticall.Call[] memory sourceCalls = new ISquidMulticall.Call[](
            1
        );
        sourceCalls[0].callType = ISquidMulticall.CallType.FullNativeBalance;
        sourceCalls[0].target = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
        sourceCalls[0].value = 0;
        // Calldata returned from Squid API for native token
        sourceCalls[0]
            .callData = hex"7ff36ab500000000000000000000000000000000000000000000000000000000093aa1390000000000000000000000000000000000000000000000000000000000000080000000000000000000000000ce16f69375520ab01377ce7b88f5ba8c48f8d66600000000000000000000000000000000000000000000000000000186b6a684d00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
        sourceCalls[0].payload = "";

        squidData.routeType = SquidFacet.RouteType.CallBridge;
        squidData.destinationChain = "Polygon";
        squidData.bridgedTokenSymbol = "USDC";
        squidData.sourceCalls = sourceCalls;

        return squidData;
    }
}
