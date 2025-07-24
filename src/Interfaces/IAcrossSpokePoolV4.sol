// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IAcrossSpokePoolV4
/// @author LI.FI (https://li.fi)
/// @custom:version 1.1.0
interface IAcrossSpokePoolV4 {
    // this function was updated with AcrossV4 to support bytes32 instead of address
    function deposit(
        // The address that made the deposit on the origin chain
        bytes32 depositor,
        // The recipient on the destination chain
        bytes32 recipient,
        // Token that is deposited on origin chain by depositor
        bytes32 inputToken,
        // Token that is received on destination chain by recipient
        bytes32 outputToken,
        // The amount of input token deposited by depositor on origin chain
        uint256 inputAmount,
        // The amount of output token to be received by recipient on destination chain
        uint256 outputAmount,
        // Destination chain id
        uint256 destinationChainId,
        // This is the exclusive relayer who can fill the deposit before the exclusivity deadline
        bytes32 exclusiveRelayer,
        // Timestamp for the quote creation
        uint32 quoteTimestamp,
        // The timestamp on the destination chain after which this deposit can no longer be filled
        uint32 fillDeadline,
        // The timestamp on the destination chain after which any relayer can fill the deposit
        uint32 exclusivityDeadline,
        // Arbitrary data that can be used to pass additional information to the recipient along with the tokens
        bytes calldata message
    ) external payable;

    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        // replaces fees
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable;
}
