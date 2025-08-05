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
        uint16 len = LibInputStream2.readUint16(stream);

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

    /** @notice Manually advances the stream's read pointer by specified bytes
     * @param stream stream
     * @param bytesToAdvance number of bytes to advance
     */
    function advance(uint256 stream, uint256 bytesToAdvance) internal pure {
        assembly {
            let pos := mload(stream)
            mstore(stream, add(pos, bytesToAdvance))
        }
    }

    /** @notice Gets remaining bytes from current position to end of stream
     * @param stream stream
     * @return remainingData bytes from current position to end
     */
    function getRemainingBytes(
        uint256 stream
    ) internal view returns (bytes memory remainingData) {
        uint256 pos;
        uint256 finish;
        assembly {
            pos := mload(stream)
            finish := mload(add(stream, 32))
        }

        uint256 remainingLength = finish - pos;
        if (remainingLength > 0) {
            assembly {
                remainingData := mload(0x40)
                mstore(0x40, add(remainingData, add(remainingLength, 32)))
                mstore(remainingData, remainingLength)
                pop(
                    staticcall(
                        gas(),
                        4,
                        pos,
                        remainingLength,
                        add(remainingData, 32),
                        remainingLength
                    )
                )
            }
        }
    }
}
