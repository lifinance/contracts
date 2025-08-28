// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @title IAlgebraPool Interface
/// @notice Interface for Algebra pool
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IAlgebraPool {
    /// @notice The first of the two tokens of the pool, sorted by address
    /// @return The token contract address
    function token0() external view returns (address);

    /// @notice Sets the initial price for the pool
    /// @dev Price is represented as a sqrt(amountToken1/amountToken0) Q64.96 value
    /// @param price the initial sqrt price of the pool as a Q64.96
    function initialize(uint160 price) external;

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

    /// @notice Adds liquidity to the pool
    /// @param sender The address that initiated the liquidity addition
    /// @param recipient The address that will receive the liquidity position
    /// @param bottomTick The lower tick of the position
    /// @param topTick The upper tick of the position
    /// @param amount The desired amount of liquidity to add
    /// @param data Any additional data required for the callback
    /// @return amount0 The amount of token0 that was paid to add liquidity
    /// @return amount1 The amount of token1 that was paid to add liquidity
    /// @return liquidityActual The actual amount of liquidity that was added to the pool
    function mint(
        address sender,
        address recipient,
        int24 bottomTick,
        int24 topTick,
        uint128 amount,
        bytes calldata data
    )
        external
        returns (uint256 amount0, uint256 amount1, uint128 liquidityActual);
}
