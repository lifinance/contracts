// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IUniV3StylePool
/// @author LI.FI (https://li.fi)
/// @notice Interface for UniV3-style pools
/// @custom:version 1.0.0
interface IUniV3StylePool {
    /// @notice Returns the address of the token0
    function token0() external view returns (address);
    /// @notice Returns the address of the token1
    function token1() external view returns (address);

    /// @notice Swaps tokens
    /// @param recipient The address of the recipient
    /// @param zeroForOne The direction of the swap, true for token0 to token1, false for token1 to token0
    /// @param amountSpecified The amount of the swap, positive for exact input, negative for exact output
    /// @param sqrtPriceLimitX96 The Q64.96 sqrt price limit
    /// @param data Any additional data required for the swap
    /// @return amount0 The amount of token0 swapped
    /// @return amount1 The amount of token1 swapped
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
