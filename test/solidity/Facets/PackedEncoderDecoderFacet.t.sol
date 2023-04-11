pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { PackedEncoderDecoderFacet } from "lifi/Facets/PackedEncoderDecoderFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { IHopBridge } from "lifi/Interfaces/IHopBridge.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";

contract PackedEncoderDecoderFacetTest is DSTest {
    address internal constant NATIVE_BRIDGE =
        0x884d1Aa15F9957E1aEAA86a82a72e49Bc2bfCbe3;

    PackedEncoderDecoderFacet internal packedEncoderDecoderFacet;
    HopFacetOptimized.HopData internal hopData;
    CBridgeFacet.CBridgeData internal cBridgeData;
    ILiFi.BridgeData internal bridgeData;

    function setUp() public {
        packedEncoderDecoderFacet = new PackedEncoderDecoderFacet();
        bridgeData = ILiFi.BridgeData({
            transactionId: bytes32(bytes8("123abc")),
            bridge: "acme",
            integrator: "lifi",
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: address(0),
            minAmount: 100,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        hopData = HopFacetOptimized.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            hopBridge: IHopBridge(NATIVE_BRIDGE)
        });
        cBridgeData = CBridgeFacet.CBridgeData(5000, 123);
    }

    function test_CanEncodeAndDecodeHopNativeCall() public {
        bytes memory encoded = packedEncoderDecoderFacet
            .encode_startBridgeTokensViaHopL2NativePacked(
            bridgeData.transactionId,
            bridgeData.integrator,
            bridgeData.receiver,
            bridgeData.destinationChainId,
            hopData.bonderFee,
            hopData.amountOutMin,
            hopData.destinationAmountOutMin,
            address(hopData.hopBridge)
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = packedEncoderDecoderFacet
                .decode_startBridgeTokensViaHopL2NativePacked(encoded);
        assertEq(decodedBridgeData.transactionId, bridgeData.transactionId);
        assertEq(decodedBridgeData.receiver, bridgeData.receiver);
        assertEq(
            decodedBridgeData.destinationChainId,
            bridgeData.destinationChainId
        );
        assertEq(decodedHopData.bonderFee, hopData.bonderFee);
        assertEq(decodedHopData.amountOutMin, hopData.amountOutMin);
        assertEq(
            decodedHopData.destinationAmountOutMin,
            hopData.destinationAmountOutMin
        );
        assertEq(
            address(decodedHopData.hopBridge),
            address(hopData.hopBridge)
        );
    }

    function test_CanEncodeAndDecodeHopERC20Call() public {
        bytes memory encoded = packedEncoderDecoderFacet
            .encode_startBridgeTokensViaHopL2ERC20Packed(
            bridgeData.transactionId,
            bridgeData.integrator,
            bridgeData.receiver,
            bridgeData.destinationChainId,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            hopData.bonderFee,
            hopData.amountOutMin,
            hopData.destinationAmountOutMin,
            address(hopData.hopBridge)
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            HopFacetOptimized.HopData memory decodedHopData
        ) = packedEncoderDecoderFacet
                .decode_startBridgeTokensViaHopL2ERC20Packed(encoded);
        assertEq(decodedBridgeData.transactionId, bridgeData.transactionId);
        assertEq(decodedBridgeData.receiver, bridgeData.receiver);
        assertEq(
            decodedBridgeData.destinationChainId,
            bridgeData.destinationChainId
        );
        assertEq(decodedBridgeData.sendingAssetId, bridgeData.sendingAssetId);
        assertEq(decodedBridgeData.minAmount, bridgeData.minAmount);
        assertEq(decodedHopData.bonderFee, hopData.bonderFee);
        assertEq(decodedHopData.amountOutMin, hopData.amountOutMin);
        assertEq(
            decodedHopData.destinationAmountOutMin,
            hopData.destinationAmountOutMin
        );
        assertEq(
            address(decodedHopData.hopBridge),
            address(hopData.hopBridge)
        );
    }

    function test_CanEncodeAndDecodeCBridgeNativeCall() public {
        bytes memory encoded = packedEncoderDecoderFacet
            .encode_startBridgeTokensViaCBridgeNativePacked(
                bridgeData.transactionId,
                bridgeData.integrator,
                bridgeData.receiver,
                uint64(bridgeData.destinationChainId),
                cBridgeData.nonce,
                cBridgeData.maxSlippage
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = packedEncoderDecoderFacet
                .decode_startBridgeTokensViaCBridgeNativePacked(encoded);
        assertEq(decodedBridgeData.transactionId, bridgeData.transactionId);
        assertEq(decodedBridgeData.receiver, bridgeData.receiver);
        assertEq(
            decodedBridgeData.destinationChainId,
            bridgeData.destinationChainId
        );
        assertEq(decodedCBridgeData.maxSlippage, cBridgeData.maxSlippage);
        assertEq(decodedCBridgeData.nonce, cBridgeData.nonce);
    }

    function test_CanEncodeAndDecodeCBridgeERC20Call() public {
        bytes memory encoded = packedEncoderDecoderFacet
            .encode_startBridgeTokensViaCBridgeERC20Packed(
                bridgeData.transactionId,
                bridgeData.integrator,
                bridgeData.receiver,
                uint64(bridgeData.destinationChainId),
                bridgeData.sendingAssetId,
                bridgeData.minAmount,
                cBridgeData.nonce,
                cBridgeData.maxSlippage
            );
        (
            ILiFi.BridgeData memory decodedBridgeData,
            CBridgeFacet.CBridgeData memory decodedCBridgeData
        ) = packedEncoderDecoderFacet
                .decode_startBridgeTokensViaCBridgeERC20Packed(encoded);
        assertEq(decodedBridgeData.transactionId, bridgeData.transactionId);
        assertEq(decodedBridgeData.receiver, bridgeData.receiver);
        assertEq(
            decodedBridgeData.destinationChainId,
            bridgeData.destinationChainId
        );
        assertEq(decodedBridgeData.sendingAssetId, bridgeData.sendingAssetId);
        assertEq(decodedBridgeData.minAmount, bridgeData.minAmount);
        assertEq(decodedCBridgeData.maxSlippage, cBridgeData.maxSlippage);
        assertEq(decodedCBridgeData.nonce, cBridgeData.nonce);
    }
}
