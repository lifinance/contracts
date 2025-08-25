// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title LibPackedStream
/// @author LI.FI (https://li.fi)
/// @notice Minimal byte-stream reader for compact calldata formats
/// @custom:version 1.0.0
library LibPackedStream {
    /// @dev Returns the start and finish pointers for a bytes array.
    function _bounds(
        bytes memory data
    ) private pure returns (uint256 start, uint256 finish) {
        assembly {
            start := add(data, 32)
            finish := add(start, mload(data))
        }
    }

    /** @notice Creates stream from data
     * @param data data
     */
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

    /** @notice Reads uint24 from the stream
     * @param stream stream
     */
    function readUint24(uint256 stream) internal pure returns (uint24 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 3)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads uint256 from the stream
     * @param stream stream
     */
    function readUint256(uint256 stream) internal pure returns (uint256 res) {
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
            res := shr(96, mload(pos))
            mstore(stream, add(pos, 20))
        }
    }

    /**
     * @notice Reads a length-prefixed data blob from the stream.
     * @dev This is the key function for enabling multi-hop swaps. It allows the
     * router to read the data for a single hop without consuming the rest
     * of the stream, which may contain data for subsequent hops.
     * It expects the stream to be encoded like this:
     * [uint16 length_of_data][bytes memory data]
     * For a multi-hop route, the stream would look like:
     * [uint16 hop1_len][bytes hop1_data][uint16 hop2_len][bytes hop2_data]...
     * @param stream The data stream to read from.
     * @return res The data blob for the current hop.
     */
    function readBytesWithLength(
        uint256 stream
    ) internal view returns (bytes memory res) {
        // Read the 2-byte length prefix to know how many bytes to read next.
        uint16 len = LibPackedStream.readUint16(stream);

        if (len > 0) {
            uint256 pos;
            assembly {
                pos := mload(stream)
            }
            assembly {
                res := mload(0x40)
                mstore(0x40, add(res, add(len, 32)))
                mstore(res, len)
                pop(staticcall(gas(), 4, pos, len, add(res, 32), len))
                // IMPORTANT: Update the stream's position pointer
                mstore(stream, add(pos, len))
            }
        }
    }
}
