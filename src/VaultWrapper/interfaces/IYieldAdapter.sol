// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IYieldAdapter
/// @author LI.FI (https://li.fi)
/// @notice Adapter abstraction over a yield source (ERC-4626 vault, Aave market, ...).
///         The factory depends only on `resolveAsset`; the wrapper implementation
///         extends this interface with runtime methods (deposit/withdraw/
///         totalAssets/convertToShares) in S1.
/// @custom:version 1.0.0
interface IYieldAdapter {
    /// @notice Thrown when the adapter cannot resolve the underlying's asset.
    error AssetResolutionFailed();

    /// @notice Resolves the ERC20 asset deposited into `_underlying` for this
    ///         adapter's protocol.
    /// @dev MUST revert if the asset cannot be resolved (wrong protocol, not a
    ///      contract, zero asset).
    /// @param _underlying The protocol-specific yield source identifier.
    /// @return asset The ERC20 token deposited into the yield source.
    function resolveAsset(
        address _underlying
    ) external view returns (address asset);
}
