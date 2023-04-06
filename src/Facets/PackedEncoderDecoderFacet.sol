pragma solidity ^0.8.17;

import { HopFacetOptimized } from "./HopFacetOptimized.sol";
import { HopFacetPacked } from "./HopFacetPacked.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";

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
}
