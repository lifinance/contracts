// SPDX-License-Identifier: MIT
/// @custom:version 1.1.0
pragma solidity ^0.8.17;

import { LibBytes } from "./LibBytes.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

library LibUtil {
    using LibBytes for bytes;

    /// @notice Extracts a revert reason from a bytes memory array
    /// @param _res The result value, usually returned by a call
    /// @return A string representing the revert reason, if extraction is possible
    function getRevertMsg(
        bytes memory _res
    ) internal pure returns (string memory) {
        // If the _res length is less than 68, then the transaction failed silently (without a revert message)
        if (_res.length < 68) return "Transaction reverted silently";
        bytes memory revertData = _res.slice(4, _res.length - 4); // Remove the selector which is the first 4 bytes
        return abi.decode(revertData, (string)); // All that remains is the revert string
    }

    /// @notice Determines whether the given address is the zero address
    /// @param addr The address to verify
    /// @return Boolean indicating if the address is the zero address
    function isZeroAddress(address addr) internal pure returns (bool) {
        return addr == address(0);
    }

    /// @notice Reverts the transaction with a given reason
    /// @param data The revert reason
    function revertWith(bytes memory data) internal pure {
        assembly {
            let dataSize := mload(data) // Load the size of the data
            let dataPtr := add(data, 0x20) // Advance data pointer to the next word
            revert(dataPtr, dataSize) // Revert with the given data
        }
    }

    /// @notice Converts an address type to a bytes32 type
    /// @param addr The address to be converted
    /// @return address in bytes32 format
    function convertAddressToBytes32(
        address addr
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    /// @notice Converts a bytes32 type to an address type
    /// @param addr The address to be converted
    /// @return address in address format
    function convertBytes32ToAddress(
        bytes32 addr
    ) internal pure returns (address) {
        return address(uint160(uint256(addr)));
    }

    /// @notice Converts an address type to a bytes memory type
    /// @param addr The address to be converted
    /// @return address in bytes memory format
    function convertAddressToBytes(
        address addr
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(addr);
    }

    /// @notice Convert a bytes memory to an address type
    /// @param addrBytes The address to be converted
    /// @return addr address in address format
    function convertBytesToAddress(
        bytes memory addrBytes
    ) internal pure returns (address addr) {
        if (addrBytes.length != 20) revert InvalidCallData();

        // using assembly here for better efficiency
        assembly {
            addr := mload(add(addrBytes, 20)) // Load 20 bytes (address size) from offset
        }
    }
}
