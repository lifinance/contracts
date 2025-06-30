// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

/// @title Interface for VelodromeV2 pool
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IVelodromeV2Pool {
    /// @notice Address of token in the pool with the lower address value
    function token0() external view returns (address);

    /// @notice Address of token in the pool with the higher address value
    function token1() external view returns (address);

    /// @notice Address of linked PoolFees.sol
    function poolFees() external view returns (address);

    /// @notice This low-level function should be called from a contract which performs important safety checks
    /// @param amount0Out   Amount of token0 to send to `to`
    /// @param amount1Out   Amount of token1 to send to `to`
    /// @param to           Address to receive the swapped output
    /// @param data         Additional calldata for flashloans
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;

    /// @notice Update reserves and, on the first call per block, price accumulators
    /// @return _reserve0 .
    /// @return _reserve1 .
    /// @return _blockTimestampLast .
    function getReserves()
        external
        view
        returns (
            uint256 _reserve0,
            uint256 _reserve1,
            uint256 _blockTimestampLast
        );

    /// @notice Get the amount of tokenOut given the amount of tokenIn
    /// @param amountIn Amount of token in
    /// @param tokenIn  Address of token
    /// @return Amount out
    function getAmountOut(
        uint256 amountIn,
        address tokenIn
    ) external view returns (uint256);
}
