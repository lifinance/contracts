// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { IAccessGate } from "lifi/VaultWrapper/interfaces/IAccessGate.sol";

/// @notice Fully controllable IAccessGate: per-account allow/sanction flags plus a global
///         transfer switch. `isTransferable` requires the switch AND both endpoints
///         allowed, so tests can express both the "allowed-to-allowed" and the soulbound
///         ("no transfers at all") gate policies.
contract MockAccessGate is IAccessGate {
    mapping(address => bool) public allowed;
    mapping(address => bool) public sanctioned;
    bool public transfersAllowed = true;

    function setAllowed(address _account, bool _value) external {
        allowed[_account] = _value;
    }

    function setSanctioned(address _account, bool _value) external {
        sanctioned[_account] = _value;
    }

    function setTransfersAllowed(bool _value) external {
        transfersAllowed = _value;
    }

    function isAllowed(address _account) external view returns (bool) {
        return allowed[_account];
    }

    function isTransferable(
        address _from,
        address _to
    ) external view returns (bool) {
        return transfersAllowed && allowed[_from] && allowed[_to];
    }

    function isSanctioned(address _account) external view returns (bool) {
        return sanctioned[_account];
    }
}

/// @notice IAccessGate whose every view reverts, to prove the wrapper is fail-closed and
///         bubbles the gate's own error verbatim on all guarded paths.
contract RevertingAccessGate is IAccessGate {
    error GateBroken();

    function isAllowed(address) external pure returns (bool) {
        revert GateBroken();
    }

    function isTransferable(address, address) external pure returns (bool) {
        revert GateBroken();
    }

    function isSanctioned(address) external pure returns (bool) {
        revert GateBroken();
    }
}
