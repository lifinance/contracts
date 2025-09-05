// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @title IAlgebraFactory Interface
/// @notice Interface for Algebra pool factory
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IAlgebraFactory {
    /// @notice Creates a pool for the given two tokens
    /// @dev tokenA and tokenB may be passed in either order: token0/token1 or token1/token0
    /// @param tokenA The contract address of either token0 or token1
    /// @param tokenB The contract address of the other token
    /// @return pool The address of the newly created pool
    function createPool(
        address tokenA,
        address tokenB
    ) external returns (address pool);
}
