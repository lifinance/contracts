// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { TestFacet } from "../utils/TestBase.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";
import { ISymbiosisMetaRouter } from "lifi/Interfaces/ISymbiosisMetaRouter.sol";

// Stub SymbiosisFacet Contract
contract TestSymbiosisFacet is SymbiosisFacet, TestFacet {
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway
    ) SymbiosisFacet(_symbiosisMetaRouter, _symbiosisGateway) {}
}

contract MockMetaRouter {
    address internal constant SYMBIOSIS_GATEWAY =
        0x25bEE8C21D1d0ec2852302fd7E674196EA298eC6;

    function metaRoute(
        ISymbiosisMetaRouter.MetaRouteTransaction calldata mt
    ) external payable {
        if (!mt.nativeIn) {
            bytes memory callData = abi.encodeWithSignature(
                "claimTokens(address,address,uint256)",
                mt.approvedTokens[0],
                msg.sender,
                mt.amount
            );
            (bool ok, ) = SYMBIOSIS_GATEWAY.call(callData);
            if (!ok) {
                revert("Couldn't pull tokens.");
            }
        }
    }
}

contract SymbiosisFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant SYMBIOSIS_METAROUTER =
        0xE75C7E85FE6ADd07077467064aD15847E6ba9877;
    address internal constant SYMBIOSIS_GATEWAY =
        0x25bEE8C21D1d0ec2852302fd7E674196EA298eC6;
    address internal constant RELAY_RECIPIENT =
        0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8;

    TestSymbiosisFacet internal symbiosisFacet;
    SymbiosisFacet.SymbiosisData internal symbiosisData;

    function setUp() public {
        initTestBase();

        MockMetaRouter mockMetaRouter = new MockMetaRouter();
        vm.etch(SYMBIOSIS_METAROUTER, address(mockMetaRouter).code);

        symbiosisFacet = new TestSymbiosisFacet(
            ISymbiosisMetaRouter(SYMBIOSIS_METAROUTER),
            SYMBIOSIS_GATEWAY
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = symbiosisFacet
            .startBridgeTokensViaSymbiosis
            .selector;
        functionSelectors[1] = symbiosisFacet
            .swapAndStartBridgeTokensViaSymbiosis
            .selector;
        functionSelectors[2] = symbiosisFacet.addDex.selector;
        functionSelectors[3] = symbiosisFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(symbiosisFacet), functionSelectors);

        symbiosisFacet = TestSymbiosisFacet(address(diamond));

        symbiosisFacet.addDex(address(uniswap));
        symbiosisFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        symbiosisFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        symbiosisFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        symbiosisFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(symbiosisFacet), "SymbiosisFacet");

        bridgeData.bridge = "symbiosis";
        bridgeData.minAmount = defaultUSDCAmount;

        bytes memory _otherSideCalldata = abi.encodeWithSignature(
            "synthesize(uint256,address,uint256,address,address,address,address,uint256,bytes32)",
            1000000, //    bridging fee
            ADDRESS_USDC, //    token address
            100000000, //   amount
            0x0f590DA07186328fCf0Ea79c73bD9b81d3263C2f, //   to,
            0xb8f275fBf7A959F4BCE59999A2EF122A099e81A8, //    synthesis,
            0x5523985926Aa12BA58DC5Ad00DDca99678D7227E, //    oppositeBridge,
            0x0f590DA07186328fCf0Ea79c73bD9b81d3263C2f, //    revertableAddress,
            56288, //    chainID,
            "" //    clientID
        );

        symbiosisData = SymbiosisFacet.SymbiosisData(
            "", // first swap calldata
            "", // second swap calldata
            address(0), //intermediateToken
            address(0), // firstDexRouter
            address(0), // secondDexRouter
            RELAY_RECIPIENT, // bridging entrypoint
            _otherSideCalldata // core bridging calldata
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            symbiosisFacet.startBridgeTokensViaSymbiosis{
                value: bridgeData.minAmount
            }(bridgeData, symbiosisData);
            assertEq(SYMBIOSIS_METAROUTER.balance, bridgeData.minAmount);
        } else {
            symbiosisFacet.startBridgeTokensViaSymbiosis(
                bridgeData,
                symbiosisData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, symbiosisData);
            assertEq(SYMBIOSIS_METAROUTER.balance, bridgeData.minAmount);
        } else {
            symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis{
                value: addToMessageValue
            }(bridgeData, swapData, symbiosisData);
        }
    }
}
