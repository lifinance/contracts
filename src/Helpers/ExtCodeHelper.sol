// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @notice Helper to isolate EXTCODECOPY in its own contract so we can catch failures
contract ExtcodeHelper {
    /// @dev returns (prefix, delegate) by reading 23 bytes of code
    function getDelegationInfo(
        address target
    ) external view returns (bytes3 prefix, address delegate) {
        bytes memory buf = new bytes(23);
        assembly {
            extcodecopy(target, add(buf, 0x20), 0, 23)
        }
        assembly {
            // buf layout at buf+0x20: [ prefix:3 | delegate:20 ]
            let ptr := add(buf, 0x20)
            prefix := mload(ptr) // loads first 32 bytes, high-order 3 bytes are our prefix
            delegate := shr(96, mload(add(ptr, 3))) // loads next 32 bytes, shift right 96 bits to drop padding
        }
    }
}
