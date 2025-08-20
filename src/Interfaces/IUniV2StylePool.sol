// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IUniV2StylePool
/// @author LI.FI (https://li.fi)
/// @notice Interface for Uniswap V2 style pools (including SushiSwap, PancakeSwap V2, etc.)
/// @dev This interface represents the core functionality of AMMs that follow UniswapV2's pool design
///      Key characteristics:
///      - Uses x * y = k formula for pricing
///      - Maintains reserves for both tokens
///      - No callbacks during swaps (unlike V3-style pools)
/// @custom:version 1.0.0
interface IUniV2StylePool {
    /// @notice Returns the current reserves of the pool and the last block timestamp
    /// @dev Values are stored as uint112 to fit into a single storage slot for gas optimization
    /// @return reserve0 The reserve of token0
    /// @return reserve1 The reserve of token1
    /// @return blockTimestampLast The timestamp of the last block where reserves were updated
    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );

    /// @notice Executes a swap in the pool
    /// @dev Unlike V3-style pools, this doesn't use callbacks - tokens must be sent to pool before swap
    /// @param amount0Out The amount of token0 to send to recipient (0 if sending token1)
    /// @param amount1Out The amount of token1 to send to recipient (0 if sending token0)
    /// @param to The address that will receive the output tokens
    /// @param data Optional data parameter, usually unused in V2-style pools
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}
