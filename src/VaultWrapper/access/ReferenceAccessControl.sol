// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "../../Helpers/TransferrableOwnership.sol";
import { IVaultAccessControl } from "../interfaces/IVaultAccessControl.sol";
import { ISanctionsOracle } from "../interfaces/ISanctionsOracle.sol";

/// @title ReferenceAccessControl
/// @author LI.FI (https://li.fi)
/// @notice Reference external access-control adapter integrators can deploy or fork to
///         gate a vault wrapper. Combines an owner-managed allowlist and denylist with an
///         optional sanctions oracle. `isAllowed`/`isDenied` are the predicates a wrapper
///         consults; the policy is: an account is denied when explicitly denylisted or
///         flagged by the sanctions oracle, and allowed when not denied and (allowlisting
///         off, or explicitly allowlisted).
/// @dev This is a template, not a LI.FI-operated contract: each integrator owns its own
///      instance. It does not custody funds and holds no balances. The sanctions oracle is
///      called directly (no try/catch); per `ISanctionsOracle` the oracle MUST be a
///      non-reverting view, so a misbehaving oracle is an integrator adapter choice, not a
///      concern of this contract.
/// @custom:version 1.0.0
contract ReferenceAccessControl is
    TransferrableOwnership,
    IVaultAccessControl
{
    /// Storage ///

    /// @notice Whether allowlisting is enforced; when false, every non-denied account is allowed.
    bool public allowlistEnabled;
    /// @notice Optional sanctions oracle; the zero address disables sanctions screening.
    ISanctionsOracle public sanctionsOracle;
    /// @notice Accounts explicitly permitted (only consulted when `allowlistEnabled`).
    mapping(address => bool) public allowlisted;
    /// @notice Accounts explicitly blocked, independent of the allowlist.
    mapping(address => bool) public denylisted;

    /// Events ///

    /// @notice Emitted when an account's allowlist membership changes.
    /// @param account The account toggled.
    /// @param allowed Whether it is now allowlisted.
    event AllowlistedSet(address indexed account, bool allowed);

    /// @notice Emitted when an account's denylist membership changes.
    /// @param account The account toggled.
    /// @param denied Whether it is now denylisted.
    event DenylistedSet(address indexed account, bool denied);

    /// @notice Emitted when allowlist enforcement is toggled.
    /// @param enabled Whether allowlisting is now enforced.
    event AllowlistEnabledSet(bool enabled);

    /// @notice Emitted when the sanctions oracle is set or cleared.
    /// @param oracle The new oracle address (zero disables screening).
    event SanctionsOracleSet(address indexed oracle);

    /// @notice Initializes the adapter with an owner and optional starting configuration.
    /// @param _owner The address that manages the lists and configuration.
    /// @param _allowlistEnabled Whether allowlist enforcement starts on.
    /// @param _sanctionsOracle Initial sanctions oracle (zero to disable).
    constructor(
        address _owner,
        bool _allowlistEnabled,
        address _sanctionsOracle
    ) TransferrableOwnership(_owner) {
        allowlistEnabled = _allowlistEnabled;
        sanctionsOracle = ISanctionsOracle(_sanctionsOracle);
    }

    /// Views ///

    /// @inheritdoc IVaultAccessControl
    function isDenied(address _account) public view returns (bool denied) {
        if (denylisted[_account]) return true;
        ISanctionsOracle oracle = sanctionsOracle;
        if (address(oracle) != address(0))
            return oracle.isSanctioned(_account);
        return false;
    }

    /// @inheritdoc IVaultAccessControl
    function isAllowed(address _account) external view returns (bool allowed) {
        if (isDenied(_account)) return false;
        return !allowlistEnabled || allowlisted[_account];
    }

    /// Configuration (owner) ///

    /// @notice Toggle a single account's allowlist membership.
    /// @param _account The account to toggle.
    /// @param _allowed Whether the account should be allowlisted.
    function setAllowlisted(
        address _account,
        bool _allowed
    ) external onlyOwner {
        allowlisted[_account] = _allowed;
        emit AllowlistedSet(_account, _allowed);
    }

    /// @notice Toggle the allowlist membership of several accounts at once.
    /// @param _accounts The accounts to toggle.
    /// @param _allowed Whether the accounts should be allowlisted.
    function setAllowlistedBatch(
        address[] calldata _accounts,
        bool _allowed
    ) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            allowlisted[_accounts[i]] = _allowed;
            emit AllowlistedSet(_accounts[i], _allowed);
        }
    }

    /// @notice Toggle a single account's denylist membership.
    /// @param _account The account to toggle.
    /// @param _denied Whether the account should be denylisted.
    function setDenylisted(address _account, bool _denied) external onlyOwner {
        denylisted[_account] = _denied;
        emit DenylistedSet(_account, _denied);
    }

    /// @notice Toggle the denylist membership of several accounts at once.
    /// @param _accounts The accounts to toggle.
    /// @param _denied Whether the accounts should be denylisted.
    function setDenylistedBatch(
        address[] calldata _accounts,
        bool _denied
    ) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            denylisted[_accounts[i]] = _denied;
            emit DenylistedSet(_accounts[i], _denied);
        }
    }

    /// @notice Enable or disable allowlist enforcement.
    /// @param _enabled Whether allowlisting should be enforced.
    function setAllowlistEnabled(bool _enabled) external onlyOwner {
        allowlistEnabled = _enabled;
        emit AllowlistEnabledSet(_enabled);
    }

    /// @notice Set or clear the sanctions oracle.
    /// @param _oracle The oracle address; the zero address disables screening.
    function setSanctionsOracle(address _oracle) external onlyOwner {
        sanctionsOracle = ISanctionsOracle(_oracle);
        emit SanctionsOracleSet(_oracle);
    }
}
