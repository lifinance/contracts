pragma solidity ^0.8.17;

import { HopFacetOptimized } from "./HopFacetOptimized.sol";
import { HopFacetPacked } from "./HopFacetPacked.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";

/// @title PackedEncoderDecoderFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for decoding packed calldata
/// @custom:version 1.0.0
contract PackedEncoderDecoderFacet is ILiFi {
    /// External Methods ///

    /// @notice Encodes calldata for startBridgeTokensViaHopL2NativePacked
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function encode_startBridgeTokensViaHopL2NativePacked(
        BridgeData calldata _bridgeData,
        HopFacetOptimized.HopData calldata _hopData
    ) external pure returns (bytes memory) {
        require(
            _bridgeData.destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            _hopData.bonderFee <= type(uint128).max,
            "bonderFee value passed too big to fit in uint128"
        );
        require(
            _hopData.amountOutMin <= type(uint128).max,
            "amountOutMin value passed too big to fit in uint128"
        );
        require(
            _hopData.destinationAmountOutMin <= type(uint128).max,
            "destinationAmountOutMin value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL2NativePacked.selector,
                bytes8(_bridgeData.transactionId),
                bytes16(bytes(_bridgeData.integrator)),
                bytes20(_bridgeData.receiver),
                bytes4(uint32(_bridgeData.destinationChainId)),
                bytes16(uint128(_hopData.bonderFee)),
                bytes16(uint128(_hopData.amountOutMin)),
                bytes16(uint128(_hopData.destinationAmountOutMin)),
                bytes20(address(_hopData.hopBridge))
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL2NativePacked
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL2NativePacked(bytes calldata _data)
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length == 120,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.integrator = string(bytes(_data[12:28]));
        bridgeData.receiver = address(bytes20(_data[28:48]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[48:52])));
        hopData.bonderFee = uint256(uint128(bytes16(_data[52:68])));
        hopData.amountOutMin = uint256(uint128(bytes16(_data[68:84])));
        hopData.destinationAmountOutMin = uint256(
            uint128(bytes16(_data[84:100]))
        );
        hopData.hopBridge = IHopBridge(address(bytes20(_data[100:120])));

        return (bridgeData, hopData);
    }

    /// @notice Encodes calldata for startBridgeTokensViaHopL2ERC20Packed
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function encode_startBridgeTokensViaHopL2ERC20Packed(
        BridgeData calldata _bridgeData,
        HopFacetOptimized.HopData calldata _hopData
    ) external pure returns (bytes memory) {
        require(
            _bridgeData.destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            _bridgeData.minAmount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            _hopData.bonderFee <= type(uint128).max,
            "bonderFee value passed too big to fit in uint128"
        );
        require(
            _hopData.amountOutMin <= type(uint128).max,
            "amountOutMin value passed too big to fit in uint128"
        );
        require(
            _hopData.destinationAmountOutMin <= type(uint128).max,
            "destinationAmountOutMin value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL2ERC20Packed.selector,
                bytes8(_bridgeData.transactionId),
                bytes16(bytes(_bridgeData.integrator)),
                bytes20(_bridgeData.receiver),
                bytes4(uint32(_bridgeData.destinationChainId)),
                bytes20(_bridgeData.sendingAssetId),
                bytes16(uint128(_bridgeData.minAmount)),
                bytes16(uint128(_hopData.bonderFee)),
                bytes16(uint128(_hopData.amountOutMin)),
                bytes16(uint128(_hopData.destinationAmountOutMin)),
                bytes20(address(_hopData.hopBridge))
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL2ERC20Packed
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL2ERC20Packed(bytes calldata _data)
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length == 156,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.integrator = string(bytes(_data[12:28]));
        bridgeData.receiver = address(bytes20(_data[28:48]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[48:52])));
        bridgeData.sendingAssetId = address(bytes20(_data[52:72]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[72:88])));
        hopData.bonderFee = uint256(uint128(bytes16(_data[88:104])));
        hopData.amountOutMin = uint256(uint128(bytes16(_data[104:120])));
        hopData.destinationAmountOutMin = uint256(
            uint128(bytes16(_data[120:136]))
        );
        hopData.hopBridge = IHopBridge(address(bytes20(_data[136:156])));

        return (bridgeData, hopData);
    }
}
