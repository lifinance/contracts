// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISpokePoolPeriphery
/// @notice Interface for interacting with Across Protocol SpokePoolPeriphery
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ISpokePoolPeriphery {
    /// @notice Enum describing the method of transferring tokens to an exchange
    enum TransferType {
        Approval, // Approve the exchange so that it may transfer tokens from SwapProxy
        Transfer, // Transfer tokens to the exchange before calling it
        Permit2Approval // Approve the exchange via Permit2
    }

    /// @notice Submission fees for gasless flows (set to zero for gasful)
    struct Fees {
        uint256 amount;
        address recipient;
    }

    /// @notice Base deposit data for Across V4 deposits
    struct BaseDepositData {
        address inputToken; // Token deposited on origin chain (after swap)
        bytes32 outputToken; // Token received on destination chain
        uint256 outputAmount; // Amount of output token to be received
        address depositor; // Account credited with deposit (receives refunds)
        bytes32 recipient; // Account receiving tokens on destination
        uint256 destinationChainId; // Destination chain ID
        bytes32 exclusiveRelayer; // Exclusive relayer (0 for none)
        uint32 quoteTimestamp; // Timestamp for fee calculation
        uint32 fillDeadline; // Deadline for fill on destination
        uint32 exclusivityParameter; // Exclusivity deadline/offset
        bytes message; // Message for destination call
    }

    /// @notice Full swap and deposit data structure
    struct SwapAndDepositData {
        Fees submissionFees; // Fees for gasless submission (zero for gasful)
        BaseDepositData depositData; // Deposit parameters
        address swapToken; // Token to swap from
        address exchange; // DEX router address
        TransferType transferType; // How to transfer tokens to exchange
        uint256 swapTokenAmount; // Amount to swap
        uint256 minExpectedInputTokenAmount; // Min output from swap (slippage)
        bytes routerCalldata; // DEX calldata
        bool enableProportionalAdjustment; // Adjust output proportionally
        address spokePool; // SpokePool address to deposit to
        uint256 nonce; // Replay protection nonce
    }

    /// @notice Swaps tokens on this chain via specified router before submitting Across deposit
    /// @param swapAndDepositData The parameters for swap and deposit
    function swapAndBridge(
        SwapAndDepositData calldata swapAndDepositData
    ) external payable;
}
