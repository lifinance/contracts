// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for VelodromeV2 router
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IVelodromeV2Router {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    /// @notice Calculate the address of a pool by its' factory.
    ///         Used by all Router functions containing a `Route[]` or `_factory` argument.
    ///         Reverts if _factory is not approved by the FactoryRegistry
    /// @dev Returns a randomly generated address for a nonexistent pool
    /// @param tokenA   Address of token to query
    /// @param tokenB   Address of token to query
    /// @param stable   True if pool is stable, false if volatile
    /// @param _factory Address of factory which created the pool
    function poolFor(
        address tokenA,
        address tokenB,
        bool stable,
        address _factory
    ) external view returns (address pool);

    /// @notice Perform chained getAmountOut calculations on any number of pools
    function getAmountsOut(
        uint256 amountIn,
        Route[] memory routes
    ) external view returns (uint256[] memory amounts);
}
