// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @title IAlgebraPool Interface
/// @notice Interface for Algebra pool with swap functionality
interface IAlgebraPool {
    /**
     * @notice The first of the two tokens of the pool, sorted by address
     * @return The token contract address
     */
    function token0() external view returns (address);

    /// @notice Swaps tokens supporting fee on input tokens
    /// @param sender The address of the sender
    /// @param recipient The address of the recipient
    /// @param zeroToOne The direction of the swap, true for token0 to token1, false for token1 to token0
    /// @param amountSpecified The amount of the swap, positive for exact input, negative for exact output
    /// @param limitSqrtPrice The Q64.96 sqrt price limit
    /// @param data Any additional data required for the swap
    /// @return amount0 The amount of token0 swapped
    /// @return amount1 The amount of token1 swapped
    function swapSupportingFeeOnInputTokens(
        address sender,
        address recipient,
        bool zeroToOne,
        int256 amountSpecified,
        uint160 limitSqrtPrice,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
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
