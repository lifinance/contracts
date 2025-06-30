// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

/// @title Interface for OmniBridge
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IOmniBridge {
    /// @dev Initiate the bridge operation for some amount of tokens from msg.sender.
    /// @param token bridged token contract address.
    /// @param receiver Receiver address
    /// @param amount Dai amount
    function relayTokens(
        address token,
        address receiver,
        uint256 amount
    ) external;

    /// @dev Wraps native assets and relays wrapped ERC20 tokens to the other chain.
    /// @param receiver Bridged assets receiver on the other side of the bridge.
    function wrapAndRelayTokens(address receiver) external payable;
}
