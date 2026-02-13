// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISponsoredOFTSrcPeriphery
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for interacting with Across Protocol's SponsoredOFTSrcPeriphery
/// @dev Upstream reference: `SponsoredOFTSrcPeriphery.sol` from Across Protocol contracts repository
///      (`contracts/periphery/mintburn/sponsored-oft/`).
/// @custom:version 1.0.0
interface ISponsoredOFTSrcPeriphery {
    /// @notice Unsigned params of the sponsored bridging flow quote
    /// @dev Upstream: UnsignedQuoteParams in `Structs.sol`
    struct UnsignedQuoteParams {
        address refundRecipient;
    }

    /// @notice Signed params of the sponsored bridging flow quote
    /// @dev Upstream: SignedQuoteParams in `Structs.sol`
    struct SignedQuoteParams {
        uint32 srcEid;
        uint32 dstEid;
        bytes32 destinationHandler;
        uint256 amountLD;
        bytes32 nonce;
        uint256 deadline;
        uint256 maxBpsToSponsor;
        uint256 maxUserSlippageBps;
        bytes32 finalRecipient;
        bytes32 finalToken;
        uint32 destinationDex;
        uint256 lzReceiveGasLimit;
        uint256 lzComposeGasLimit;
        uint256 maxOftFeeBps;
        uint8 accountCreationMode;
        uint8 executionMode;
        bytes actionData;
    }

    /// @notice A structure with all the relevant information about a particular sponsored bridging flow order
    /// @dev Upstream: Quote in `Structs.sol`
    struct Quote {
        SignedQuoteParams signedParams;
        UnsignedQuoteParams unsignedParams;
    }

    /// @notice Main entrypoint function to start the sponsored OFT user flow
    /// @param quote The quote struct containing all transfer parameters
    /// @param signature The signature authorizing the quote
    function deposit(
        Quote calldata quote,
        bytes calldata signature
    ) external payable;
}
