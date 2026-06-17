// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IYieldAdapter
/// @author LI.FI (https://li.fi)
/// @notice Adapter abstraction over a yield source (ERC-4626 vault, Aave market, ...).
///         The factory depends only on `probe`; the wrapper implementation extends
///         this interface with runtime methods (deposit/withdraw/totalAssets/
///         convertToShares) in S1.
/// @custom:version 1.0.0
interface IYieldAdapter {
    /// @notice Validates that `_underlying` is a usable yield source for this
    ///         adapter's protocol and returns its ERC20 asset.
    /// @dev MUST revert if `_underlying` is unusable (wrong protocol, not a
    ///      contract, zero asset, broken introspection).
    /// @param _underlying The protocol-specific yield source identifier.
    /// @return asset The ERC20 token deposited into the yield source.
    function probe(address _underlying) external view returns (address asset);
}
