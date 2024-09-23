// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

/// @title Interface for GasZip
/// @author LI.FI (https://li.fi)
interface IGasZip {
    /// @dev GasZip-specific bridge data
    /// @param destinationChains a value that represents a list of chains to which gas should be distributed (see https://dev.gas.zip/gas/code-examples/deposit for more details)
    /// @param receiver the address to receive the gas on dst chain
    struct GasZipData {
        uint256 destinationChains;
        address receiver;
    }

    function deposit(
        uint256 destinationChains,
        address recipient
    ) external payable;
}
