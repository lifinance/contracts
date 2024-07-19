// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console } from "../utils/TestBaseFacet.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";
import { IOmniBridge } from "lifi/Interfaces/IOmniBridge.sol";

// Stub OmniBridgeFacet Contract
contract TestOmniBridgeFacet is OmniBridgeFacet {
    constructor(
        IOmniBridge _foreignOmniBridge,
        IOmniBridge _wethOmniBridge
    ) OmniBridgeFacet(_foreignOmniBridge, _wethOmniBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract OmniBridgeL2FacetTest is TestBaseFacet {
    // These values are for Gnosis Chain
    address internal constant FOREIGN_BRIDGE =
        0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d;
    address internal constant WETH_BRIDGE =
        0x0000000000000000000000000000000000000000;

    // -----

    TestOmniBridgeFacet internal omniBridgeFacet;

    function setUp() public {
        // Fork Gnosis chain
        customRpcUrlForForking = "ETH_NODE_URI_GNOSIS";
        customBlockNumberForForking = 26862566;
        ADDRESS_USDC = 0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83;
        ADDRESS_USDT = 0x4ECaBa5870353805a9F068101A40E0f32ed605C6;
        ADDRESS_DAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
        ADDRESS_WETH = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
        ADDRESS_UNISWAP = 0x1C232F01118CB8B424793ae03F870aa7D0ac7f77;

        initTestBase();

        omniBridgeFacet = new TestOmniBridgeFacet(
            IOmniBridge(FOREIGN_BRIDGE),
            IOmniBridge(WETH_BRIDGE)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = omniBridgeFacet
            .startBridgeTokensViaOmniBridge
            .selector;
        functionSelectors[1] = omniBridgeFacet
            .swapAndStartBridgeTokensViaOmniBridge
            .selector;
        functionSelectors[2] = omniBridgeFacet.addDex.selector;
        functionSelectors[3] = omniBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(omniBridgeFacet), functionSelectors);

        omniBridgeFacet = TestOmniBridgeFacet(address(diamond));

        omniBridgeFacet.addDex(address(uniswap));
        omniBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        omniBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        omniBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );

        setFacetAddressInTestBase(address(omniBridgeFacet), "OmniBridgeFacet");

        bridgeData.bridge = "omni";
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            omniBridgeFacet.startBridgeTokensViaOmniBridge{
                value: bridgeData.minAmount
            }(bridgeData);
        } else {
            omniBridgeFacet.startBridgeTokensViaOmniBridge(bridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData);
        } else {
            omniBridgeFacet.swapAndStartBridgeTokensViaOmniBridge(
                bridgeData,
                swapData
            );
        }
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }
}
