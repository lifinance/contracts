// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

interface ICentrifugeTokenBridge {
    /// @notice Send a token from chain A to chain B
    /// @param token The address of the token to send
    /// @param amount The amount of the token to send
    /// @param receiver The target address on the destination chain (bytes32 for non-EVM support)
    /// @param destinationChainId The EVM chain ID of the destination chain
    /// @param refundAddress The address to refund excess gas fees to
    /// @return Arbitrary return data
    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    ) external payable returns (bytes memory);
}
