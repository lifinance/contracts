// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISponsoredCCTPSrcPeriphery
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for interacting with Across Protocol's SponsoredCCTPSrcPeriphery
/// @dev Upstream reference: `SponsoredCCTPSrcPeriphery.sol` + `SponsoredCCTPInterface.sol` from Across Protocol
///      contracts repository (`contracts/periphery/mintburn/sponsored-cctp/`).
/// @custom:version 1.0.0
interface ISponsoredCCTPSrcPeriphery {
    /// @notice Params used to create a sponsored CCTP quote and deposit for burn
    /// @dev Mirrors `SponsoredCCTPInterface.SponsoredCCTPQuote` (Across)
    struct SponsoredCCTPQuote {
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes32 nonce;
        uint256 deadline;
        uint256 maxBpsToSponsor;
        uint256 maxUserSlippageBps;
        bytes32 finalRecipient;
        bytes32 finalToken;
        uint8 executionMode;
        bytes actionData;
    }

    /// @notice Deposits tokens for burn via CCTP
    /// @param quote The quote that contains the data for the deposit
    /// @param signature The signature of the quote
    function depositForBurn(
        SponsoredCCTPQuote calldata quote,
        bytes calldata signature
    ) external;
}
