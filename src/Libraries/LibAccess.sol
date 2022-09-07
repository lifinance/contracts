// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

/// @title Access Library
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for managing method level access control
library LibAccess {
    /// Types ///
    bytes32 internal constant ACCESS_MANAGEMENT_POSITION =
        hex"df05114fe8fad5d7cd2d71c5651effc2a4c21f13ee8b4a462e2a3bd4e140c73e"; // keccak256("com.lifi.library.access.management")

    /// Storage ///
    struct AccessStorage {
        mapping(bytes4 => mapping(address => bool)) execAccess;
    }

    /// Errors ///
    error UnAuthorized();

    /// @dev Fetch local storage
    function accessStorage() internal pure returns (AccessStorage storage accStor) {
        bytes32 position = ACCESS_MANAGEMENT_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            accStor.slot := position
        }
    }

    /// @notice Gives an address permission to execute a method
    /// @param selector The method selector to execute
    /// @param executor The address to grant permission to
    function addAccess(bytes4 selector, address executor) internal {
        AccessStorage storage accStor = accessStorage();
        accStor.execAccess[selector][executor] = true;
    }

    /// @notice Revokes permission to execute a method
    /// @param selector The method selector to execute
    /// @param executor The address to revoke permission from
    function removeAccess(bytes4 selector, address executor) internal {
        AccessStorage storage accStor = accessStorage();
        accStor.execAccess[selector][executor] = false;
    }

    /// @notice Enforces access control by reverting if `msg.sender`
    ///     has not been given permission to execute `msg.sig`
    function enforceAccessControl() internal view {
        AccessStorage storage accStor = accessStorage();
        if (accStor.execAccess[msg.sig][msg.sender] != true) revert UnAuthorized();
    }
}
