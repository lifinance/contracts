// SPDX-License-Identifier: LGPL-3.0-only
/// @custom:version 1.1.0
pragma solidity ^0.8.17;

struct QuoteSendInfo {
    Fee gmpFee;
    uint256 amountSent;
    uint256 valueSent;
    AirliftFeeInfo airliftFeeInfo;
}

struct AirliftFeeInfo {
    Fee airliftFee;
    uint256 correctedAmount;
    uint256 correctedValue;
}

struct Fee {
    uint256 nativeFee;
    uint256 tokenFee;
}

interface IGlacisAirlift {
    /// Use to send a token from chain A to chain B with a specific output token.
    /// This allows routing through a specific bridge when multiple bridges are available.
    /// @param token The address of the token sending across chains.
    /// @param amount The amount of the token you want to send across chains.
    /// @param receiver The target address that should receive the funds on the destination chain.
    /// @param destinationChainId The Ethereum chain ID of the destination chain.
    /// @param refundAddress The address that should receive any funds in the case the cross-chain gas value is too high.
    /// @param outputToken The address of the token to receive on the destination chain. Use bytes32(0) for default routing.
    /// @return sendResponse The response from the token's handler function: not standardized.
    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress,
        bytes32 outputToken
    ) external payable returns (bytes memory);

    /// Use to quote the send a token from chain A to chain B.
    /// @param token The address of the token sending across chains.
    /// @param amount The amount of the token you want to send across chains.
    /// @param receiver The target address that should receive the funds on the destination chain.
    /// @param destinationChainId The Ethereum chain ID of the destination chain.
    /// @param refundAddress The address that should receive any funds in the case the cross-chain gas value is too high.
    /// @param msgValue The value that will be sent with the transaction.
    /// @return The amount of token and value fees required to send the token across chains.
    function quoteSend(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress,
        uint256 msgValue
    ) external returns (QuoteSendInfo memory);

    /// Use to quote sending a token from chain A to chain B with a specific output token.
    /// @param token The address of the token sending across chains.
    /// @param amount The amount of the token you want to send across chains.
    /// @param receiver The target address that should receive the funds on the destination chain.
    /// @param destinationChainId The Ethereum chain ID of the destination chain.
    /// @param refundAddress The address that should receive any funds in the case the cross-chain gas value is too high.
    /// @param msgValue The value that will be sent with the transaction.
    /// @param outputToken The address of the token to receive on the destination chain. Use bytes32(0) for default routing.
    /// @return The amount of token and value fees required to send the token across chains.
    function quoteSend(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress,
        uint256 msgValue,
        bytes32 outputToken
    ) external returns (QuoteSendInfo memory);
}
