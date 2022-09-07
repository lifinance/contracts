// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";

/// @title Access Manager Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for managing method level access control
contract AccessManagerFacet {
    /// @notice Sets whether a specific address can call a method
    /// @param _selector The method selector to set access for
    /// @param _executor The address to set method access for
    /// @param _canExecute Whether or not the address can execute the specified method
    function setCanExecute(
        bytes4 _selector,
        address _executor,
        bool _canExecute
    ) external {
        LibDiamond.enforceIsContractOwner();
        _canExecute ? LibAccess.addAccess(_selector, _executor) : LibAccess.removeAccess(_selector, _executor);
    }

    /// @notice Check if a method can be executed by a specific address
    /// @param _selector The method selector to check
    /// @param _executor The address to check
    function addressCanExecuteMethod(bytes4 _selector, address _executor) external view returns (bool) {
        return LibAccess.accessStorage().execAccess[_selector][_executor];
    }
}
