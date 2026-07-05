// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IVaultAccessControl } from "lifi/VaultWrapper/interfaces/IVaultAccessControl.sol";

/// @notice Configurable IVaultAccessControl adapter: both predicates are independent
///         settable sets, so one instance can serve an allow gate, a deny gate, or both.
contract MockVaultAccessControl is IVaultAccessControl {
    mapping(address => bool) public allowed;
    mapping(address => bool) public denied;

    function setAllowed(address _account, bool _allowed) external {
        allowed[_account] = _allowed;
    }

    function setDenied(address _account, bool _denied) external {
        denied[_account] = _denied;
    }

    function isAllowed(address _account) external view returns (bool) {
        return allowed[_account];
    }

    function isDenied(address _account) external view returns (bool) {
        return denied[_account];
    }
}

/// @notice Adapter whose predicates always revert, used to assert the wrapper's
///         fail-closed behavior on a broken external backend.
contract RevertingVaultAccessControl is IVaultAccessControl {
    error AdapterBroken();

    function isAllowed(address) external pure returns (bool) {
        revert AdapterBroken();
    }

    function isDenied(address) external pure returns (bool) {
        revert AdapterBroken();
    }
}
