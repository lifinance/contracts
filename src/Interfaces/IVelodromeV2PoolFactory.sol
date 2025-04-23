// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for VelodromeV2 pool factory
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IVelodromeV2PoolFactory {
    /// @notice Returns fee for a pool, as custom fees are possible.
    function getFee(
        address _pool,
        bool _stable
    ) external view returns (uint256);
}
