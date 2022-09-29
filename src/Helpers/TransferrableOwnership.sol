// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC173 } from "../Interfaces/IERC173.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract TransferrableOwnership is IERC173 {
    address public owner;
    address public pendingOwner;

    /// Errors ///
    error UnAuthorized();
    error NoNullOwner();
    error NewOwnerMustNotBeSelf();
    error NoPendingOwnershipTransfer();
    error NotPendingOwner();

    /// Events ///
    event OwnershipTransferRequested(address indexed _from, address indexed _to);

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnAuthorized();
        _;
    }

    /// @notice Initiates transfer of ownership to a new address
    /// @param _newOwner the address to transfer ownership to
    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == LibAsset.NULL_ADDRESS) revert NoNullOwner();
        if (_newOwner == msg.sender) revert NewOwnerMustNotBeSelf();
        pendingOwner = _newOwner;
        emit OwnershipTransferRequested(msg.sender, pendingOwner);
    }

    /// @notice Cancel transfer of ownership
    function cancelOwnershipTransfer() external onlyOwner {
        if (pendingOwner == LibAsset.NULL_ADDRESS) revert NoPendingOwnershipTransfer();
        pendingOwner = LibAsset.NULL_ADDRESS;
    }

    /// @notice Confirms transfer of ownership to the calling address (msg.sender)
    function confirmOwnershipTransfer() external {
        address _pendingOwner = pendingOwner;
        if (msg.sender != _pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, _pendingOwner);
        owner = _pendingOwner;
        pendingOwner = LibAsset.NULL_ADDRESS;
    }
}
