// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { RoninBridgeFacet } from "lifi/Facets/RoninBridgeFacet.sol";
import { IRoninBridgeGateway } from "lifi/Interfaces/IRoninBridgeGateway.sol";

// Stub RoninBridgeFacet Contract
contract TestRoninBridgeFacet is RoninBridgeFacet {
    constructor(IRoninBridgeGateway _gateway) RoninBridgeFacet(_gateway) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract RoninBridgeFacetTest is TestBaseFacet {
    // These values are for Mainnet
    address internal constant MAINCHAIN_GATEWAY =
        0x64192819Ac13Ef72bF6b5AE239AC672B43a9AF08;

    // -----

    TestRoninBridgeFacet internal roninBridgeFacet;

    function setUp() public {
        // set custom block number for forking
        customBlockNumberForForking = 16705000;

        initTestBase();

        roninBridgeFacet = new TestRoninBridgeFacet(
            IRoninBridgeGateway(MAINCHAIN_GATEWAY)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = roninBridgeFacet
            .startBridgeTokensViaRoninBridge
            .selector;
        functionSelectors[1] = roninBridgeFacet
            .swapAndStartBridgeTokensViaRoninBridge
            .selector;
        functionSelectors[2] = roninBridgeFacet.addDex.selector;
        functionSelectors[3] = roninBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(roninBridgeFacet), functionSelectors);

        roninBridgeFacet = TestRoninBridgeFacet(address(diamond));

        roninBridgeFacet.addDex(address(uniswap));
        roninBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        roninBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(
            address(roninBridgeFacet),
            "RoninBridgeFacet"
        );

        bridgeData.destinationChainId = 2020;
        bridgeData.bridge = "ronin";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            roninBridgeFacet.startBridgeTokensViaRoninBridge{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            roninBridgeFacet.startBridgeTokensViaRoninBridge(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative)
        internal
        override
    {
        if (isNative) {
            roninBridgeFacet.swapAndStartBridgeTokensViaRoninBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            roninBridgeFacet.swapAndStartBridgeTokensViaRoninBridge(
                bridgeData,
                swapData
            );
        }
    }
}
