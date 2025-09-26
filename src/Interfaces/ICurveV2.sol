// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Curve V2
/// @author LI.FI (https://li.fi)
/// @notice Minimal Curve V2 pool interface for exchange operations
/// @custom:version 1.0.0
interface ICurveV2 {
    /// @notice Performs a token swap on a Curve V2 pool.
    /// @dev This function is used to swap tokens in a Curve V2 pool and specifies the recipient of the swapped tokens.
    /// It is not `payable` and assumes that the input token has already been approved for transfer by the caller.
    /// @param i The index of the token to sell.
    /// @param j The index of the token to buy.
    /// @param dx The amount of the input token to sell.
    /// @param min_dy The minimum amount of the output token to receive (slippage control).
    /// @param receiver The address to which the swapped tokens will be sent.
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external;

    /// @param i The index of the token to sell.
    /// @param j The index of the token to buy.
    /// @param dx The amount of the input token to sell.
    /// @param min_dy The minimum amount of the output token to receive (slippage control).
    /// @param receiver The address to which the swapped tokens will be sent.
    function exchange_received(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external;
}
