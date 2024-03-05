// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { MayanBridgeFacet } from "lifi/Facets/MayanBridgeFacet.sol";
import { IMayanBridge } from "lifi/Interfaces/IMayanBridge.sol";

// Stub MayanBridgeFacet Contract
contract TestMayanBridgeFacet is MayanBridgeFacet {
    constructor(IMayanBridge _bridge) MayanBridgeFacet(_bridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract MayanBridgeFacetTest is TestBaseFacet {
    MayanBridgeFacet.MayanBridgeData internal validMayanBridgeData;
    TestMayanBridgeFacet internal mayanBridgeFacet;
    IMayanBridge internal MAYAN_BRIDGE =
        IMayanBridge(0xF3f04555f8FdA510bfC77820FD6eB8446f59E72d);

    function setUp() public {
        customBlockNumberForForking = 19367700;
        initTestBase();

        address[] memory EXAMPLE_ALLOWED_TOKENS = new address[](2);
        EXAMPLE_ALLOWED_TOKENS[0] = address(1);
        EXAMPLE_ALLOWED_TOKENS[1] = address(2);

        mayanBridgeFacet = new TestMayanBridgeFacet(MAYAN_BRIDGE);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = mayanBridgeFacet
            .startBridgeTokensViaMayanBridge
            .selector;
        functionSelectors[1] = mayanBridgeFacet
            .swapAndStartBridgeTokensViaMayanBridge
            .selector;
        functionSelectors[2] = mayanBridgeFacet.addDex.selector;
        functionSelectors[3] = mayanBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(mayanBridgeFacet), functionSelectors);
        mayanBridgeFacet = TestMayanBridgeFacet(address(diamond));
        mayanBridgeFacet.addDex(ADDRESS_UNISWAP);
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        mayanBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(
            address(mayanBridgeFacet),
            "MayanBridgeFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "mayanBridge";
        bridgeData.destinationChainId = 137;

        // produce valid MayanBridgeData
        validMayanBridgeData = MayanBridgeFacet.MayanBridgeData({
            mayanAddr: 0x32f0af4069bde51a996d1250ef3f7c2431245b98e027b34aa5ca5ae435c435c9,
            referrer: bytes32(0),
            tokenOutAddr: bytes32(0),
            receiver: bytes32(uint256(uint160(USER_SENDER))),
            swapFee: 50000,
            redeemFee: 0,
            refundFee: 3000000,
            transferDeadline: block.timestamp + 1000,
            swapDeadline: uint64(block.timestamp + 1000),
            amountOutMin: 0,
            unwrap: false,
            gasDrop: 0
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        uint256 totalFees = validMayanBridgeData.redeemFee +
            validMayanBridgeData.refundFee +
            validMayanBridgeData.swapFee;
        validMayanBridgeData.amountOutMin = uint64(
            (bridgeData.minAmount * 99) / 100
        );
        if (isNative) {
            mayanBridgeFacet.startBridgeTokensViaMayanBridge{
                value: bridgeData.minAmount + totalFees
            }(bridgeData, validMayanBridgeData);
        } else {
            mayanBridgeFacet.startBridgeTokensViaMayanBridge{
                value: totalFees
            }(bridgeData, validMayanBridgeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayanBridge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validMayanBridgeData);
        } else {
            mayanBridgeFacet.swapAndStartBridgeTokensViaMayanBridge(
                bridgeData,
                swapData,
                validMayanBridgeData
            );
        }
    }
}
