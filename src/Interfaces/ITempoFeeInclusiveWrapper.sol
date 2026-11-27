// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ITempoFeeInclusiveWrapper
/// @notice Minimal interface for Frax's Tempo fee-inclusive entrypoint over HopV2
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev Shadows FraxFinance src/contracts/hop/TempoFeeInclusiveWrapper.sol (verified on
///      https://contracts.tempo.xyz, chain 4217)
interface ITempoFeeInclusiveWrapper {
    /// @notice Pulls `maxAmountInLD` of the OFT token from msg.sender, pays the LayerZero fee
    ///         out of it, bridges the dust-floored remainder and refunds any residual to
    ///         msg.sender in the same call
    /// @param oft Address of the OFT messenger on Tempo
    /// @param dstEid LayerZero endpoint ID of the destination chain
    /// @param recipient bytes32-encoded recipient on the destination chain
    /// @param maxAmountInLD Gross amount pulled from msg.sender (bridged amount + fee)
    /// @param minNetAmountLD Minimum bridged amount after the fee; must be non-zero
    /// @param dstGas Gas forwarded to the destination delivery
    /// @param data Must be empty (compose is not supported)
    function sendOFTFeeInclusive(
        address oft,
        uint32 dstEid,
        bytes32 recipient,
        uint256 maxAmountInLD,
        uint256 minNetAmountLD,
        uint128 dstGas,
        bytes calldata data
    ) external payable;

    /// @notice Previews a fee-inclusive send with the derivation the send itself checks against
    /// @param oft Address of the OFT messenger on Tempo
    /// @param dstEid LayerZero endpoint ID of the destination chain
    /// @param recipient bytes32-encoded recipient on the destination chain
    /// @param maxAmountInLD Gross amount the send would pull
    /// @param dstGas Gas forwarded to the destination delivery
    /// @param data Must be empty
    /// @return feeToken The token the fee is taken from (the OFT's token)
    /// @return feeAmount The most the hop will debit for the fee
    /// @return netAmount The amount that would be bridged (0 if the fee exceeds the budget)
    function quoteFeeInclusive(
        address oft,
        uint32 dstEid,
        bytes32 recipient,
        uint256 maxAmountInLD,
        uint128 dstGas,
        bytes calldata data
    )
        external
        view
        returns (address feeToken, uint256 feeAmount, uint256 netAmount);

    /// @notice The HopV2 spoke this wrapper forwards to
    /// @return hop The HopV2 address
    function HOP() external view returns (address hop);
}
