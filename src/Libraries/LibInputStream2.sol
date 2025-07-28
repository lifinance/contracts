// SPDX-License-Identifier: LGPL-3.0-only
/// @custom:version 1.0.2
pragma solidity ^0.8.17;

/// @title InputStream Library (Corrected)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for reading data from packed byte streams.
library LibInputStream2 {
    /** @notice Creates stream from data
     * @param data data
     */
function createStream(
    bytes memory data
) internal pure returns (uint256 stream) {
    assembly {
        stream := mload(0x40)
        mstore(0x40, add(stream, 64))
        let dataContentPtr := add(data, 32)
        mstore(stream, dataContentPtr)
        let length := mload(data)
        let endPtr := add(dataContentPtr, length)
        mstore(add(stream, 32), endPtr)
    }
}


    /** @notice Checks if stream is not empty
     * @param stream stream
     */
    function isNotEmpty(uint256 stream) internal pure returns (bool) {
        uint256 pos;
        uint256 finish;
        assembly {
            pos := mload(stream)
            finish := mload(add(stream, 32))
        }
        return pos < finish;
    }

    /** @notice Reads uint8 from the stream
     * @param stream stream
     */
    function readUint8(uint256 stream) internal pure returns (uint8 res) {
        assembly {
            let pos := mload(stream)
            res := byte(0, mload(pos))
            mstore(stream, add(pos, 1))
        }
    }

    /** @notice Reads uint16 from the stream
     * @param stream stream
     */
    function readUint16(uint256 stream) internal pure returns (uint16 res) {
        assembly {
            let pos := mload(stream)
            res := shr(240, mload(pos))
            mstore(stream, add(pos, 2))
        }
    }

    /** @notice Reads uint32 from the stream
     * @param stream stream
     */
    function readUint32(uint256 stream) internal pure returns (uint32 res) {
        assembly {
            let pos := mload(stream)
            res := shr(224, mload(pos))
            mstore(stream, add(pos, 4))
        }
    }

    /** @notice Reads bytes4 from the stream (for function selectors)
     * @param stream stream
     */
    function readBytes4(uint256 stream) internal pure returns (bytes4 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 4))
        }
    }

    /** @notice Reads uint256 from the stream
     * @param stream stream
     */
    function readUint(uint256 stream) internal pure returns (uint256 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

    /** @notice Reads bytes32 from the stream
     * @param stream stream
     */
    function readBytes32(uint256 stream) internal pure returns (bytes32 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

/** @notice Reads address from the stream
 * @param stream stream
 */
function readAddress(uint256 stream) internal pure returns (address res) {
    assembly {
        let pos := mload(stream)
        // CORRECT: Load a 32-byte word. The address is the first 20 bytes.
        // To get it, we must shift the word right by (32-20)*8 = 96 bits.
        res := shr(96, mload(pos)) 
        // Then, advance the pointer by the size of an address
        mstore(stream, add(pos, 20))
    }
}

// In LibInputStream2.sol

/** @notice Reads all remaining bytes from the stream into a new bytes array
 * @param stream stream
 */
function readRemainingBytes(
    uint256 stream
) internal view returns (bytes memory res) {
    uint256 pos;
    uint256 finish;
    assembly {
        pos := mload(stream)
        finish := mload(add(stream, 32))
    }

    uint256 len = finish - pos;

    if (len > 0) {
        assembly {
            res := mload(0x40)
            mstore(0x40, add(res, add(len, 32)))
            mstore(res, len)
            pop(staticcall(gas(), 4, pos, len, add(res, 32), len))
        }
    }
    
    assembly {
        mstore(stream, finish)
    }
}
}