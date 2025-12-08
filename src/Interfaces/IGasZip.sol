// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for GasZip
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IGasZip {
    /// @dev GasZip-specific bridge data
    /// @param receiverAddress the address on destination chain(s) where gas should be sent to
    /// @param destinationChains a value that represents a list of chains to which gas should be distributed
    ///                          (see https://dev.gas.zip/gas/code-examples/deposit for more details)
    struct GasZipData {
        bytes32 receiverAddress;
        // EVM addresses need to be padded with trailing 0s, e.g.:
        // 0x391E7C679D29BD940D63BE94AD22A25D25B5A604000000000000000000000000 (correct)
        // 0x000000000000000000000000391E7C679D29BD940D63BE94AD22A25D25B5A604 (incorrect)
        uint256 destinationChains;
    }

    function deposit(uint256 destinationChains, bytes32 to) external payable;
}
