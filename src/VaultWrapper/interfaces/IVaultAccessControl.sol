// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IVaultAccessControl
/// @author LI.FI (https://li.fi)
/// @notice External access-control hook a vault wrapper consults to gate participation.
///         A wrapper running in allowlist mode requires `isAllowed`; in denylist mode it
///         requires `!isDenied`; "both" mode requires `isAllowed && !isDenied`. The two
///         predicates are independent so a single adapter can serve every mode.
/// @dev Named `IVaultAccessControl` (not `IAccessControl`) to avoid colliding with
///      OpenZeppelin v5's role-based `IAccessControl`, which this subsystem vendors.
///      Implementations MUST be side-effect-free views: a wrapper calls them on the
///      hot deposit path, so they must not revert on unknown accounts (return false
///      instead) and should bound their gas.
/// @custom:version 1.0.0
interface IVaultAccessControl {
    /// @notice Whether `_account` is permitted to participate (allowlist semantics).
    /// @param _account The account being checked.
    /// @return allowed True if the account passes the allow policy.
    function isAllowed(address _account) external view returns (bool allowed);

    /// @notice Whether `_account` is explicitly blocked (denylist semantics).
    /// @param _account The account being checked.
    /// @return denied True if the account is blocked.
    function isDenied(address _account) external view returns (bool denied);
}
