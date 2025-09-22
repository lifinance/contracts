// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IERC1271
/// @notice Interface for EIP-1271: Standard Signature Validation Method for Contracts
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IERC1271 {
    /// @notice Should return whether the signature provided is valid for the provided hash
    /// @param hash Hash of the data to be signed
    /// @param signature Signature byte array associated with hash
    /// @return magicValue The bytes4 magic value 0x1626ba7e when function passes
    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view returns (bytes4 magicValue);
}
