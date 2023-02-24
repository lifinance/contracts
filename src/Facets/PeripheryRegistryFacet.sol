// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";

/// @title Periphery Registry Facet
/// @author LI.FI (https://li.fi)
/// @notice A simple registry to track LIFI periphery contracts
contract PeripheryRegistryFacet {

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
        LibMappings.PeripheryRegistryMappings storage s = LibMappings
            .getPeripheryRegistryMappings();
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
        return LibMappings
            .getPeripheryRegistryMappings().contracts[_name];
    }
}
