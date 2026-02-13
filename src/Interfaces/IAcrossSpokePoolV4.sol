// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IAcrossSpokePoolV4
/// @notice Interface for interacting with Across Protocol V4 Spoke Pool
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev Mirrors deposit(bytes32,...) from across-protocol/contracts SpokePool.sol; live signature on SpokePool implementation.
interface IAcrossSpokePoolV4 {
    /// @notice Bundled parameters for `deposit` (useful for calldata decoding/validation)
    /// @dev Not used by SpokePool; for consumers decoding deposit(...) calldata without a long tuple.
    struct DepositParams {
        bytes32 depositor; // Origin-chain depositor (bytes32 for cross-chain)
        bytes32 recipient; // Destination-chain recipient (bytes32 for cross-chain)
        bytes32 inputToken; // Token deposited on origin
        bytes32 outputToken; // Token received on destination
        uint256 inputAmount; // Amount deposited on origin
        uint256 outputAmount; // Amount received on destination (after fees)
        uint256 destinationChainId; // Destination chain ID
        bytes32 exclusiveRelayer; // Exclusive relayer (0 for none)
        uint32 quoteTimestamp; // Quote timestamp for fee calculation
        uint32 fillDeadline; // Deadline for fill on destination
        uint32 exclusivityParameter; // 0 = none; < MAX = offset from now; else absolute deadline
        bytes message; // Arbitrary data for recipient (e.g. swap instructions)
    }

    /// @notice Initiates a cross-chain token transfer via Across Protocol V4
    /// @param depositor Origin-chain depositor (bytes32 for cross-chain)
    /// @param recipient Destination-chain recipient (bytes32 for cross-chain)
    /// @param inputToken Token deposited on origin chain
    /// @param outputToken Token received on destination chain
    /// @param inputAmount Amount deposited on origin
    /// @param outputAmount Amount received on destination (after fees)
    /// @param destinationChainId Destination chain ID
    /// @param exclusiveRelayer Exclusive relayer; 0 for none
    /// @param quoteTimestamp Quote timestamp for fee calculation
    /// @param fillDeadline Deadline for fill on destination chain
    /// @param exclusivityParameter 0 = no exclusivity; < MAX = offset from now; else absolute deadline
    /// @param message Arbitrary data for recipient (e.g. swap instructions, destination calldata)
    function deposit(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32 exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;
}
