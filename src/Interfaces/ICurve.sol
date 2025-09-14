// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Curve
/// @author LI.FI (https://li.fi)
/// @notice Minimal Curve pool interface for exchange operations
/// @custom:version 1.0.0
interface ICurve {
    /// @notice Performs a token swap on a Curve pool.
    /// @dev This function is a minimal interface for the `exchange` function found on various Curve pools.
    /// It is marked `payable` to allow for swaps involving native tokens (e.g., ETH) in some pools.
    /// @param i The index of the token to sell.
    /// @param j The index of the token to buy.
    /// @param dx The amount of the input token to sell.
    /// @param min_dy The minimum amount of the output token to receive (slippage control).
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external payable;
}
