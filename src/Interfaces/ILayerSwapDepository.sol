// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ILayerSwapDepository
/// @notice Interface for the LayerSwap Depository contract that forwards
///         deposited funds to a whitelisted receiver
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ILayerSwapDepository {
    /// @notice Forwards native tokens to a whitelisted receiver
    /// @param id Unique identifier correlating with the off-chain order
    /// @param receiver Whitelisted address to receive the funds
    function depositNative(bytes32 id, address receiver) external payable;

    /// @notice Forwards ERC20 tokens from the caller to a whitelisted receiver
    /// @dev Caller must approve the depository for `amount` before calling
    /// @param id Unique identifier correlating with the off-chain order
    /// @param token ERC20 token address
    /// @param receiver Whitelisted address to receive the funds
    /// @param amount Amount of tokens to forward
    function depositERC20(
        bytes32 id,
        address token,
        address receiver,
        uint256 amount
    ) external;
}
