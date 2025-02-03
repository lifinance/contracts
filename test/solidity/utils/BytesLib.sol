// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

library BytesLib {
    /// @notice Returns the index of the first occurrence of `needle` in `haystack`.
    /// @dev If not found, returns type(uint256).max.
    /// @param haystack The byte array to search in.
    /// @param needle The byte array to search for.
    function indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        if (needle.length > haystack.length) {
            return type(uint256).max;
        }
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) {
                return i;
            }
        }
        return type(uint256).max;
    }
}
