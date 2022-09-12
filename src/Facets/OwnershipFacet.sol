// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { IERC173 } from "../Interfaces/IERC173.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

/// @title Ownership Facet
/// @author LI.FI (https://li.fi)
/// @notice Manages ownership of the LiFi Diamond contract for admin purposes
contract OwnershipFacet is IERC173 {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.ownership");
    struct Storage {
        address newOwner;
    }

    /// Errors ///

    error NoNullOwner();
    error NewOwnerMustNotBeSelf();
    error NoPendingOwnershipTransfer();
    error NotPendingOwner();

    /// Events ///

    event OwnershipTransferRequested(address indexed _from, address indexed _to);

    /// External Methods ///

    /// @notice Initiates transfer of ownership to a new address
    /// @param _newOwner the address to transfer ownership to
    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();

        if (LibUtil.isZeroAddress(_newOwner)) revert NoNullOwner();

        if (_newOwner == LibDiamond.contractOwner()) revert NewOwnerMustNotBeSelf();

        s.newOwner = _newOwner;
        emit OwnershipTransferRequested(msg.sender, s.newOwner);
    }

    /// @notice Cancel transfer of ownership
    function cancelOwnershipTransfer() external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();

        if (LibUtil.isZeroAddress(s.newOwner)) revert NoPendingOwnershipTransfer();
        s.newOwner = address(0);
    }

    /// @notice Confirms transfer of ownership to the calling address (msg.sender)
    function confirmOwnershipTransfer() external {
        Storage storage s = getStorage();
        address _pendingOwner = s.newOwner;
        if (msg.sender != _pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(LibDiamond.contractOwner(), _pendingOwner);
        LibDiamond.setContractOwner(_pendingOwner);
        s.newOwner = LibAsset.NULL_ADDRESS;
    }

    /// @notice Return the current owner address
    /// @return owner_ The current owner address
    function owner() external view override returns (address owner_) {
        owner_ = LibDiamond.contractOwner();
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
