// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title LibPackedStream
/// @author LI.FI (https://li.fi)
/// @notice A library for reading compact byte streams with minimal overhead
/// @dev Provides functions to read various integer types and addresses from a byte stream.
///      All integer reads are big-endian. The stream pointer advances after each read.
/// @custom:version 1.0.0
library LibPackedStream {
    /// @notice Returns the start and finish pointers for a bytes array
    /// @param data The bytes array to get bounds for
    /// @return start The pointer to the start of the actual bytes data (after length prefix)
    /// @return finish The pointer to the end of the bytes data
    function _bounds(
        bytes memory data
    ) private pure returns (uint256 start, uint256 finish) {
        assembly {
            start := add(data, 32)
            finish := add(start, mload(data))
        }
    }

    /// @notice Creates a new stream from a bytes array
    /// @dev Allocates memory for stream pointers and initializes them
    /// @param data The source bytes to create a stream from
    /// @return stream A pointer to the stream struct (contains current position and end)
    function createStream(
        bytes memory data
    ) internal pure returns (uint256 stream) {
        (uint256 start, uint256 finish) = _bounds(data);
        assembly {
            stream := mload(0x40)
            mstore(stream, start)
            mstore(add(stream, 32), finish)
            mstore(0x40, add(stream, 64))
        }
    }

    /// @notice Checks if there are unread bytes in the stream
    /// @param stream The stream to check
    /// @return True if current position is before end of stream
    function isNotEmpty(uint256 stream) internal pure returns (bool) {
        uint256 pos;
        uint256 finish;
        assembly {
            pos := mload(stream)
            finish := mload(add(stream, 32))
        }
        return pos < finish;
    }

    /// @notice Reads a uint8 from the current stream position
    /// @dev Reads 1 byte and advances stream by 1
    /// @param stream The stream to read from
    /// @return res The uint8 value read
    function readUint8(uint256 stream) internal pure returns (uint8 res) {
        assembly {
            let pos := mload(stream)
            res := byte(0, mload(pos))
            mstore(stream, add(pos, 1))
        }
    }

    /// @notice Reads a uint16 from the current stream position
    /// @dev Reads 2 bytes big-endian and advances stream by 2
    /// @param stream The stream to read from
    /// @return res The uint16 value read
    function readUint16(uint256 stream) internal pure returns (uint16 res) {
        assembly {
            let pos := mload(stream)
            res := shr(240, mload(pos))
            mstore(stream, add(pos, 2))
        }
    }

    /// @notice Reads a uint24 from the current stream position
    /// @dev Reads 3 bytes big-endian and advances stream by 3
    /// @param stream The stream to read from
    /// @return res The uint24 value read
    function readUint24(uint256 stream) internal pure returns (uint24 res) {
        assembly {
            let pos := mload(stream)
            res := shr(232, mload(pos))
            mstore(stream, add(pos, 3))
        }
    }

    /// @notice Reads a uint256 from the current stream position
    /// @dev Reads 32 bytes and advances stream by 32
    /// @param stream The stream to read from
    /// @return res The uint256 value read
    function readUint256(uint256 stream) internal pure returns (uint256 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

    /// @notice Reads a bytes32 from the current stream position
    /// @dev Reads 32 bytes and advances stream by 32
    /// @param stream The stream to read from
    /// @return res The bytes32 value read
    function readBytes32(uint256 stream) internal pure returns (bytes32 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

    /// @notice Reads an address from the current stream position
    /// @dev Reads 20 bytes and advances stream by 20
    /// @param stream The stream to read from
    /// @return res The address value read
    function readAddress(uint256 stream) internal pure returns (address res) {
        assembly {
            let pos := mload(stream)
            res := shr(96, mload(pos))
            mstore(stream, add(pos, 20))
        }
    }

    /// @notice Reads a length-prefixed byte array from the stream
    /// @dev Format: [uint16 length][bytes data]. Used for multi-hop routes where each hop's
    ///      data is prefixed with its length. Example of a 2-hop route encoding:
    ///      [uint16 hop1_len][bytes hop1_data][uint16 hop2_len][bytes hop2_data]
    /// @param stream The stream to read from
    /// @return res The bytes array read from the stream (without length prefix)
    function readBytesWithLength(
        uint256 stream
    ) internal view returns (bytes memory res) {
        // Read the 2-byte length prefix
        uint16 len = LibPackedStream.readUint16(stream);

        if (len > 0) {
            uint256 pos;
            assembly {
                pos := mload(stream)
            }
            assembly {
                // Allocate memory for result
                res := mload(0x40)
                mstore(0x40, add(res, add(len, 32)))
                // Store length and copy data
                mstore(res, len)
                pop(staticcall(gas(), 4, pos, len, add(res, 32), len))
                // Advance stream pointer
                mstore(stream, add(pos, len))
            }
        }
    }
}
