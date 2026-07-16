// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { IAccessGate } from "lifi/VaultWrapper/interfaces/IAccessGate.sol";

/// @title ReferenceAccessGate
/// @author LI.FI (https://li.fi)
/// @notice Reference `IAccessGate` implementation showing how to gate a LI.FI Earn vault
///         wrapper. Combines an owner-managed allowlist, denylist, and sanction flags:
///         - `isAllowed` (entry) folds in every check — an account is allowed only when it
///           is neither denylisted nor sanctioned and, when the allowlist is enforced, is
///           allowlisted.
///         - `isTransferable` (share movement) keeps the perimeter sealed by requiring both
///           endpoints to satisfy `isAllowed`; it does not soulbind shares.
///         - `isSanctioned` (exit freeze) exposes the sanction flags directly.
/// @dev This is a template, not a LI.FI-operated contract: each integrator deploys or forks
///      its own instance. It custodies no funds. Sanction flags are owner-managed here to
///      keep the example self-contained; an integrator wanting a live feed can instead back
///      `isSanctioned` with a call to an external Chainalysis `SanctionsList`, whose
///      `isSanctioned(address)` signature is identical.
/// @custom:version 1.0.0
contract ReferenceAccessGate is TransferrableOwnership, IAccessGate {
    /// Storage ///

    /// @notice Whether allowlisting is enforced; when false, every non-blocked account may enter.
    bool public allowlistEnabled;
    /// @notice Accounts explicitly permitted (only consulted when `allowlistEnabled`).
    mapping(address => bool) public allowlisted;
    /// @notice Accounts explicitly blocked, independent of the allowlist.
    mapping(address => bool) public denylisted;
    /// @notice Accounts flagged as sanctioned (hard exit freeze).
    mapping(address => bool) public sanctioned;

    /// Events ///

    /// @notice Emitted when an account's allowlist membership changes.
    event AllowlistedSet(address indexed account, bool allowed);
    /// @notice Emitted when an account's denylist membership changes.
    event DenylistedSet(address indexed account, bool denied);
    /// @notice Emitted when an account's sanction flag changes.
    event SanctionedSet(address indexed account, bool flagged);
    /// @notice Emitted when allowlist enforcement is toggled.
    event AllowlistEnabledSet(bool enabled);

    /// @notice Initializes the gate with an owner and starting allowlist mode.
    /// @param _owner The address that manages the lists and configuration.
    /// @param _allowlistEnabled Whether allowlist enforcement starts on.
    constructor(
        address _owner,
        bool _allowlistEnabled
    ) TransferrableOwnership(_owner) {
        allowlistEnabled = _allowlistEnabled;
    }

    /// Views ///

    /// @inheritdoc IAccessGate
    function isSanctioned(address _account) public view returns (bool) {
        return sanctioned[_account];
    }

    /// @inheritdoc IAccessGate
    function isAllowed(address _account) public view returns (bool) {
        if (denylisted[_account] || sanctioned[_account]) return false;
        return !allowlistEnabled || allowlisted[_account];
    }

    /// @inheritdoc IAccessGate
    function isTransferable(
        address _from,
        address _to
    ) external view returns (bool) {
        return isAllowed(_from) && isAllowed(_to);
    }

    /// Configuration (owner) ///

    /// @notice Toggle one account's allowlist membership.
    function setAllowlisted(
        address _account,
        bool _allowed
    ) external onlyOwner {
        allowlisted[_account] = _allowed;
        emit AllowlistedSet(_account, _allowed);
    }

    /// @notice Toggle several accounts' allowlist membership at once.
    function setAllowlistedBatch(
        address[] calldata _accounts,
        bool _allowed
    ) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            allowlisted[_accounts[i]] = _allowed;
            emit AllowlistedSet(_accounts[i], _allowed);
        }
    }

    /// @notice Toggle one account's denylist membership.
    function setDenylisted(address _account, bool _denied) external onlyOwner {
        denylisted[_account] = _denied;
        emit DenylistedSet(_account, _denied);
    }

    /// @notice Toggle several accounts' denylist membership at once.
    function setDenylistedBatch(
        address[] calldata _accounts,
        bool _denied
    ) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            denylisted[_accounts[i]] = _denied;
            emit DenylistedSet(_accounts[i], _denied);
        }
    }

    /// @notice Toggle one account's sanction flag.
    function setSanctioned(
        address _account,
        bool _flagged
    ) external onlyOwner {
        sanctioned[_account] = _flagged;
        emit SanctionedSet(_account, _flagged);
    }

    /// @notice Toggle several accounts' sanction flags at once.
    function setSanctionedBatch(
        address[] calldata _accounts,
        bool _flagged
    ) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            sanctioned[_accounts[i]] = _flagged;
            emit SanctionedSet(_accounts[i], _flagged);
        }
    }

    /// @notice Enable or disable allowlist enforcement.
    function setAllowlistEnabled(bool _enabled) external onlyOwner {
        allowlistEnabled = _enabled;
        emit AllowlistEnabledSet(_enabled);
    }
}
