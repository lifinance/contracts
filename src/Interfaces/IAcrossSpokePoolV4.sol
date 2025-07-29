// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IAcrossSpokePoolV4
/// @notice Interface for interacting with Across Protocol V4 Spoke Pool
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IAcrossSpokePoolV4 {
    /// @notice Initiates a cross-chain token transfer via Across Protocol V4
    /// @dev This function allows users to deposit tokens on the origin chain for bridging to a destination chain.
    ///      The function supports both EVM and non-EVM chains through the use of bytes32 addresses.
    ///      The deposit can be filled by relayers on the destination chain within the specified deadlines.
    /// @param depositor The address that made the deposit on the origin chain (bytes32 format for cross-chain compatibility)
    /// @param recipient The recipient address on the destination chain (bytes32 format for cross-chain compatibility)
    /// @param inputToken The token address that is deposited on the origin chain by the depositor (bytes32 format)
    /// @param outputToken The token address that will be received on the destination chain by the recipient (bytes32 format)
    /// @param inputAmount The amount of input token deposited by the depositor on the origin chain
    /// @param outputAmount The amount of output token to be received by the recipient on the destination chain (after fees)
    /// @param destinationChainId The chain ID of the destination chain where the tokens will be received
    /// @param exclusiveRelayer The exclusive relayer address who can fill the deposit before the exclusivity deadline.
    ///                         Set to zero bytes32 if no exclusive relayer is specified
    /// @param quoteTimestamp The timestamp when the quote was created, used for fee calculation and validation
    /// @param fillDeadline The timestamp on the destination chain after which this deposit can no longer be filled by any relayer
    /// @param exclusivityDeadline The timestamp on the destination chain after which any relayer can fill the deposit.
    ///                           Before this deadline, only the exclusive relayer can fill the deposit
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens.
    ///                This can include swap instructions, destination call data, or other cross-chain messages
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
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable;
}
