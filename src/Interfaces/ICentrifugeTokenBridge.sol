// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ICentrifugeTokenBridge
/// @notice Interface for the Centrifuge TokenBridge used to send share tokens across chains
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev Shadows Centrifuge's `src/bridge/interfaces/ITokenBridge.sol`, verified on Ethereum
///      at 0x82a6C7753380f98c093B27c53f86ef6b09C40f49. Only `send` is declared here since it
///      is the only function our facet calls.
interface ICentrifugeTokenBridge {
    /// @notice Sends a share token to the destination chain after approving this contract with the token
    /// @dev The bridge pulls `amount` from `msg.sender`, so the caller must approve it first. There is no
    ///      on-chain fee quote: the native amount required to pay for the cross-chain message is supplied
    ///      by the caller as `msg.value` and forwarded to the Centrifuge Gateway.
    /// @param token The share token to send across chains
    /// @param amount The amount of the token to send across chains
    /// @param receiver The address that should receive the funds on the destination chain, as bytes32
    /// @param destinationChainId The EVM chain id of the destination chain
    /// @param refundAddress The address that receives any excess native funds, given that they are not
    ///        routed to the bridge's configured relayer
    /// @return The response from the token's handler function (not standardized, currently empty)
    function send(
        address token,
        uint256 amount,
        bytes32 receiver,
        uint256 destinationChainId,
        address refundAddress
    ) external payable returns (bytes memory);
}
