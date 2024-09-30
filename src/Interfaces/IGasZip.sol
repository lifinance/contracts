// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

/// @title Interface for GasZip
/// @author LI.FI (https://li.fi)
interface IGasZip {
    /// @dev GasZip-specific bridge data
    /// @param destinationChains a value that represents a list of chains to which gas should be distributed (see https://dev.gas.zip/gas/code-examples/deposit for more details)
    /// @param receiver the address on destination chain(s) where gas should be sent to
    struct GasZipData {
        uint256 destinationChains;
        // EVM addresses need to be padded with trailing 0s, e.g.:
        // 0x391E7C679D29BD940D63BE94AD22A25D25B5A604000000000000000000000000 (correct)
        // 0x000000000000000000000000391E7C679D29BD940D63BE94AD22A25D25B5A604 (incorrect)
        bytes32 receiver;
    }

    function deposit(uint256 chains, bytes32 to) external payable;
}
