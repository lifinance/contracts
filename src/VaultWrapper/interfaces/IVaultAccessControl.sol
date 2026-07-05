// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IVaultAccessControl
/// @author LI.FI (https://li.fi)
/// @notice External access-control adapter a vault wrapper instance can gate deposits
///         through. The two predicates are independent so one adapter can serve an
///         allowlist gate, a denylist gate, or both at once; the wrapper queries the
///         share receiver (the end user), never `msg.sender`. Named to avoid clashing
///         with OpenZeppelin's role-based `IAccessControl`.
/// @custom:version 1.0.0
interface IVaultAccessControl {
    /// @notice Whether an account is a member of the adapter's allowlist.
    /// @param _account The account to check (the share receiver).
    /// @return True if the account may receive shares under an allow gate.
    function isAllowed(address _account) external view returns (bool);

    /// @notice Whether an account is a member of the adapter's denylist.
    /// @param _account The account to check (the share receiver).
    /// @return True if the account must be rejected under a deny gate.
    function isDenied(address _account) external view returns (bool);
}
