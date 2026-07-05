// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ISanctionsOracle } from "lifi/VaultWrapper/interfaces/ISanctionsOracle.sol";

/// @notice Configurable Chainalysis-shaped sanctions oracle for the access-control suite.
contract MockSanctionsOracle is ISanctionsOracle {
    mapping(address => bool) public sanctioned;

    function setSanctioned(address _account, bool _sanctioned) external {
        sanctioned[_account] = _sanctioned;
    }

    function isSanctioned(address _account) external view returns (bool) {
        return sanctioned[_account];
    }
}

/// @notice Oracle that always reverts, used to assert the wrapper's fail-closed
///         behavior on a broken sanctions source.
contract RevertingSanctionsOracle is ISanctionsOracle {
    error OracleBroken();

    function isSanctioned(address) external pure returns (bool) {
        revert OracleBroken();
    }
}
