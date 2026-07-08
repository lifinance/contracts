// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IAccessGate
/// @author LI.FI (https://li.fi)
/// @notice Pluggable per-instance access hook for the vault wrapper. A wrapper with a
///         zero gate is fully permissionless; a non-zero gate governs the perimeter:
///         entry (`isAllowed` on the share receiver), share movement (`isTransferable`),
///         and a hard exit freeze (`isSanctioned` on the share owner and asset receiver).
///         Gates are authored per instance (by the integrator or LI.FI) and may compose
///         any allow/block/sanctions logic internally; `isAllowed` is expected to already
///         fold in the gate's own sanctions view. All hooks are views invoked via
///         staticcall from the wrapper's hot paths; the wrapper is fail-closed, so a
///         reverting gate blocks the guarded operation and its error bubbles verbatim.
/// @custom:version 1.0.0
interface IAccessGate {
    /// @notice Whether `_account` may enter the vault (receive newly minted shares).
    /// @param _account The share receiver being screened.
    /// @return True if deposits/mints for `_account` are allowed.
    function isAllowed(address _account) external view returns (bool);

    /// @notice Whether wrapper shares may move from `_from` to `_to`.
    /// @dev Only consulted for holder-to-holder transfers; mints, burns, and the
    ///      wrapper's own fee payouts never reach the gate.
    /// @param _from The current share holder.
    /// @param _to The transfer recipient.
    /// @return True if the transfer is allowed.
    function isTransferable(
        address _from,
        address _to
    ) external view returns (bool);

    /// @notice Whether `_account` is sanction-flagged (hard exit freeze).
    /// @param _account The share owner or asset receiver being screened on exit.
    /// @return True if `_account` is sanctioned.
    function isSanctioned(address _account) external view returns (bool);
}
