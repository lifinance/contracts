// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISanctionsOracle
/// @author LI.FI (https://li.fi)
/// @notice Sanctions-screening oracle hook, signature-compatible with Chainalysis'
///         on-chain `SanctionsList` so a live oracle drops in without a shim. An
///         instance disables the hook by setting the oracle to `address(0)`.
/// @custom:version 1.0.0
interface ISanctionsOracle {
    /// @notice Whether an account appears on the sanctions list.
    /// @param _account The account to screen (the share receiver or transfer recipient).
    /// @return True if the account is sanctioned.
    function isSanctioned(address _account) external view returns (bool);
}
