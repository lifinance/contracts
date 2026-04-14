// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISponsoredCCTPSrcPeriphery
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for interacting with Across Protocol's SponsoredCCTPSrcPeriphery
/// @dev Upstream: https://github.com/across-protocol/contracts/blob/b052f8359430bdca799696d35dbc63ed5df5fcd1/contracts/interfaces/SponsoredCCTPInterface.sol
/// @custom:version 1.0.0
interface ISponsoredCCTPSrcPeriphery {
    /// @notice Execution modes for the sponsored CCTP flow
    enum ExecutionMode {
        DirectToCore,
        ArbitraryActionsToCore,
        ArbitraryActionsToEVM
    }

    /// @notice Params used to create a sponsored CCTP quote and deposit for burn
    /// @dev Mirrors SponsoredCCTPInterface.SponsoredCCTPQuote (Across)
    struct SponsoredCCTPQuote {
        uint32 sourceDomain; // CCTP domain ID of the source chain
        uint32 destinationDomain; // CCTP domain ID of the destination chain
        bytes32 mintRecipient; // Recipient of the minted USDC on the destination chain
        uint256 amount; // Amount the user pays on the source chain
        bytes32 burnToken; // Token to be burned on the source chain
        bytes32 destinationCaller; // Caller on the destination chain
        uint256 maxFee; // Max fee on destination domain, in units of burnToken
        uint32 minFinalityThreshold; // Min finality threshold before attestation allowed
        bytes32 nonce; // Replay-protection nonce
        uint256 deadline; // Quote expiry timestamp
        uint256 maxBpsToSponsor; // Max basis points of amount that can be sponsored
        uint256 maxUserSlippageBps; // Slippage tolerance for destination fees (swap flow)
        bytes32 finalRecipient; // Final recipient (mintRecipient is handler; this is end recipient)
        bytes32 finalToken; // Token final recipient receives; may differ from burnToken (destination swap)
        uint32 destinationDex; // Destination DEX on HyperCore
        uint8 accountCreationMode; // Standard or FromUserFunds
        uint8 executionMode; // ExecutionMode: DirectToCore, ArbitraryActionsToCore, or ArbitraryActionsToEVM
        bytes actionData; // Encoded action data for arbitrary execution; empty for DirectToCore
    }

    /// @notice Deposits tokens for burn via CCTP using a signed quote
    /// @param quote The sponsored CCTP quote (source/destination domains, amounts, recipient, execution mode, etc.)
    /// @param signature The signature over the quote authorizing the deposit
    function depositForBurn(
        SponsoredCCTPQuote calldata quote,
        bytes calldata signature
    ) external;
}
