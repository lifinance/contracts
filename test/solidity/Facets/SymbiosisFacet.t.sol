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

        bytes
            //bridging callData for symbiosis, taken from API
            memory _otherSideCalldata = hex"ce654c170000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000003d0900000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a80000000000000000000000005523985926aa12ba58dc5ad00ddca99678d7227e000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000000000000000000000000000000000000000dbe00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000cb28fbe3e9c0fea62e0e63ff3f232cecfe555ad40000000000000000000000000000000000000000000000000000000000000260000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a800000000000000000000000000000000000000000000000000000000000005800000000000000000000000000000000000000000000000000000000000000064000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd73796d62696f7369732d6170690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000007d6ec42b5d9566931560411a8652cea00b90d9820000000000000000000000001a25beb8e75626addb983d46fbdfce5fdc29ae5800000000000000000000000000000000000000000000000000000000000002e41e859a050000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000b79a4f5828eb55c10d7abf4bfe9a9f5d11aa84e00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c48f6bdeaa000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000005f210700000000000000000000000000000000000000000000000056273f5076323c548000000000000000000000000b79a4f5828eb55c10d7abf4bfe9a9f5d11aa84e000000000000000000000000000000000000000000000000000000000773594000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000006148fd6c649866596c3d8a971fc313e5ece8488200000000000000000000000000000000000000000000000000000000000000020000000000000000000000007d6ec42b5d9566931560411a8652cea00b90d9820000000000000000000000001a25beb8e75626addb983d46fbdfce5fdc29ae5800000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000464e691a2aa000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000006f05b59d3b200000000000000000000000000000000000000000000000000056958607e76d5de97000000000000000000000000b79a4f5828eb55c10d7abf4bfe9a9f5d11aa84e00000000000000000000000001111111254eeb25477b68fb85ed929f73a9605820000000000000000000000001a25beb8e75626addb983d46fbdfce5fdc29ae5800000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000000c4000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd0000000000000000000000005aa5f7f84ed0e5db0a4a85c3947ea16b53352fd4000000000000000000000000b8f275fbf7a959f4bce59999a2ef122a099e81a8000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd000000000000000000000000000000000000000000000000000000000000003873796d62696f7369732d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000026812aa3caf000000000000000000000000170d2ed0b2a5d9f450652be814784f964749ffa4000000000000000000000000e9e7cea3dedca5984780bafc599bd69add087d56000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000170d2ed0b2a5d9f450652be814784f964749ffa4000000000000000000000000f93d011544e89a28b5bdbdd833016cc5f26e82cd00000000000000000000000000000000000000000000000562680524a323de97000000000000000000000000000000000000000000000000056e206e23d308cd000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d90000000000000000000000000000000000000000bb0000a500006900001a0020d6bdbf78e9e7cea3dedca5984780bafc599bd69add087d5602a00000000000000000000000000000000000000000000000000000000000000001ee63c1e50085faac652b707fdf6907ef726751087f9e0b6687e9e7cea3dedca5984780bafc599bd69add087d564101bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00042e1a7d4d0000000000000000000000000000000000000000000000000000000000000000c0611111111254eeb25477b68fb85ed929f73a96058200000000000000ea698b470000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

        symbiosisData = SymbiosisFacet.SymbiosisData(
            "",// first swap calldata
            "",// second swap calldata
            address(0), //intermediateToken
            ADDRESS_USDC, // bridgingToken
            address(0), // firstDexRouter
            address(0),// secondDexRouter
            RELAY_RECIPIENT, // bridging entrypoint
            _otherSideCalldata // core bridging calldata
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {

        if (isNative) {
            symbiosisFacet.startBridgeTokensViaSymbiosis{
            value: bridgeData.minAmount
            }(bridgeData, symbiosisData);
        } else {
            symbiosisFacet.startBridgeTokensViaSymbiosis(
                bridgeData, symbiosisData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {

        if (isNative) {
            symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis{
            value: swapData[0].fromAmount
            }(bridgeData,swapData, symbiosisData);
        } else {

            symbiosisFacet.swapAndStartBridgeTokensViaSymbiosis{ value: addToMessageValue }(
                bridgeData,
                swapData,
                symbiosisData
            );
        }
    }


    function testBase_CanBridgeNativeTokens() public override {
//        address[] memory path = new address[](2);
//        path[0] = ADDRESS_WETH;
//        path[1] = ADDRESS_USDC;
//
//        symbiosisData.intermediateToken = ADDRESS_USDC;
//        symbiosisData.firstDexRouter = address(ADDRESS_UNISWAP);
//        symbiosisData.firstSwapCalldata = abi.encodeWithSelector(
//            uniswap.swapExactETHForTokens.selector,
//            0,
//            path,
//            SYMBIOSIS_METAROUTER,
//            block.timestamp + 20 minutes
//        );
//
//        super.testBase_CanBridgeNativeTokens();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        //native token bridging not supported by core bridge, it's supported by swapping to USDC/WETH on metaRouter
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
//        // amount should be greater than execution fee
//        vm.assume(amount > 10);
//        super.testBase_CanBridgeTokens_fuzzed(amount);
    }


    function testBase_CanBridgeTokens() public override {
        //        // amount should be greater than execution fee
        //        vm.assume(amount > 10);
              super.testBase_CanBridgeTokens();
    }


    function testBase_CanSwapAndBridgeTokens() public override {
        //        // amount should be greater than execution fee
        //        vm.assume(amount > 10);
        //        super.testBase_CanBridgeTokens_fuzzed(amount);
    }

}
