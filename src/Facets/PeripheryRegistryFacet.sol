// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title Periphery Registry Facet
/// @author LI.FI (https://li.fi)
/// @notice A simple registry to track LIFI periphery contracts
/// @custom:version 1.0.0
contract PeripheryRegistryFacet {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.periphery_registry");

    /// Types ///

    struct Storage {
        mapping(string => address) contracts;
    }

    /// Events ///

    event PeripheryContractRegistered(string name, address contractAddress);

    /// External Methods ///

    /// @notice Registers a periphery contract address with a specified name
    /// @param _name the name to register the contract address under
    /// @param _contractAddress the address of the contract to register
    function registerPeripheryContract(
        string calldata _name,
        address _contractAddress
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.contracts[_name] = _contractAddress;
        emit PeripheryContractRegistered(_name, _contractAddress);
    }

    /// @notice Returns the registered contract address by its name
    /// @param _name the registered name of the contract
    function getPeripheryContract(string calldata _name)
        external
        view
        returns (address)
    {
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
