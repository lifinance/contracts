// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IExtcodeHelper {
    /// @notice Read 23 bytes of code and split into prefix (3) + delegate (20)
    function getDelegationInfo(
        address target
    ) external view returns (bytes3 prefix, address delegate);
}
