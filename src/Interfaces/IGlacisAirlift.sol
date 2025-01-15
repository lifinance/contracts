// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.17;

struct QuoteSendInfo {
    Fee gmpFee;
    uint256 amountSent;
    uint256 valueSent;
    AirliftFeeInfo AirliftFeeInfo;
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
    /// Use to send a token from chain A to chain B after sending this contract the token already.
    /// This function should only be used when a smart contract calls it, so that the token's transfer
    /// and the cross-chain send are atomic within a single transaction.
    /// @param token The address of the token sending across chains.
    /// @param amount The amount of the token you want to send across chains.
    /// @param receiver The target address that should receive the funds on the destination chain.
    /// @param destinationChainId The Ethereum chain ID of the destination chain.
    /// @param refundAddress The address that should receive any funds in the case the cross-chain gas value is too high.
    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    ) external payable;

    /// Use to quote the send a token from chain A to chain B.
    /// @param token The address of the token sending across chains.
    /// @param amount The amount of the token you want to send across chains.
    /// @param receiver The target address that should receive the funds on the destination chain.
    /// @param destinationChainId The Ethereum chain ID of the destination chain.
    /// @param refundAddress The address that should receive any funds in the case the cross-chain gas value is too high.
    function quoteSend(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress,
        uint256 msgValue
    ) external returns (QuoteSendInfo memory);
}
