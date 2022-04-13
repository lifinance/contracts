// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { IERC173 } from "../Interfaces/IERC173.sol";

contract OwnershipFacet is IERC173 {
    event OwnershipTransferRequested(address indexed _from, address indexed _to);
    address private newOwner;

    error NoNullOwner();
    error NewOwnerMustNotBeSelf();
    error NoPendingOwnershipTransfer();
    error NotPendingOwner();

    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();

        if (_newOwner == address(0)) revert NoNullOwner();

        if (_newOwner == LibDiamond.contractOwner()) revert NewOwnerMustNotBeSelf();

        newOwner = _newOwner;
        emit OwnershipTransferRequested(msg.sender, newOwner);
    }

    function cancelOnwershipTransfer() external {
        LibDiamond.enforceIsContractOwner();
        if (newOwner == address(0)) revert NoPendingOwnershipTransfer();
        newOwner = address(0);
    }

    function confirmOwnershipTransfer() external {
        if (msg.sender != newOwner) revert NotPendingOwner();
        LibDiamond.setContractOwner(newOwner);
        newOwner = address(0);
        emit OwnershipTransferred(LibDiamond.contractOwner(), newOwner);
    }

    function owner() external view override returns (address owner_) {
        owner_ = LibDiamond.contractOwner();
    }
}
