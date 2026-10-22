// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title LibPeripheryRegistry
/// @author LI.FI (https://li.fi)
/// @notice Reads the periphery contracts `PeripheryRegistryFacet` registers, from inside the Diamond
/// @custom:version 1.0.0
library LibPeripheryRegistry {
    /// Storage ///
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.periphery_registry");

    /// Types ///

    /// @dev Must match `PeripheryRegistryFacet.Storage`
    struct Storage {
        mapping(string => address) contracts;
    }

    /// Internal Methods ///

    /// @notice Returns the contract registered under `_name`, or the zero address
    /// @param _name The registered name of the contract
    /// @return The registered contract, or the zero address
    function get(string memory _name) internal view returns (address) {
        return getStorage().contracts[_name];
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
