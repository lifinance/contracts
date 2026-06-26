// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISanctionsOracle
/// @author LI.FI (https://li.fi)
/// @notice On-chain sanctions screening oracle. Deliberately matches the signature of
///         Chainalysis' `SanctionsList.isSanctioned(address)` so a deployed Chainalysis
///         oracle can be used directly as the screening source without a wrapper shim.
/// @dev Implementations MUST be side-effect-free views and MUST NOT revert for unknown
///      accounts (return false), since a vault wrapper may call this on the hot path.
/// @custom:version 1.0.0
interface ISanctionsOracle {
    /// @notice Whether `_account` appears on the sanctions list.
    /// @param _account The account being screened.
    /// @return sanctioned True if the account is sanctioned.
    function isSanctioned(
        address _account
    ) external view returns (bool sanctioned);
}
