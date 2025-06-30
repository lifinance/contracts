// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

/// @title Interface for ERC-173 (Contract Ownership Standard)
/// @author LI.FI (https://li.fi)
/// Note: the ERC-165 identifier for this interface is 0x7f5828d0
/// @custom:version 1.0.0
interface IERC173 {
    /// @dev This emits when ownership of a contract changes.
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    /// @notice Get the address of the owner
    /// @return owner_ The address of the owner.
    function owner() external view returns (address owner_);

    /// @notice Set the address of the new owner of the contract
    /// @dev Set _newOwner to address(0) to renounce any ownership.
    /// @param _newOwner The address of the new owner of the contract
    function transferOwnership(address _newOwner) external;
}
