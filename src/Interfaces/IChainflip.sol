// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Interface for Chainflip Vault contract
/// @custom:version 1.0.0
interface IChainflipVault {
    /// @notice Swaps native token to any supported asset on any supported chain
    /// @param dstChain Destination chain for the swap
    /// @param dstAddress Address where the swapped tokens will be sent to on the destination chain
    /// @param dstToken Chainflip specific token identifier on the destination chain
    /// @param cfParameters Additional metadata for future features
    function xSwapNative(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        bytes calldata cfParameters
    ) external payable;

    /// @notice Swaps ERC20 token to any supported asset on any supported chain
    /// @param dstChain Destination chain for the swap
    /// @param dstAddress Address where the swapped tokens will be sent to on the destination chain
    /// @param dstToken Chainflip specific token identifier on the destination chain
    /// @param srcToken Address of the token to be swapped from the source chain
    /// @param amount Amount of the source token to be swapped
    /// @param cfParameters Additional metadata for future features
    function xSwapToken(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        IERC20 srcToken,
        uint256 amount,
        bytes calldata cfParameters
    ) external;

    /// @notice Swaps native token and calls a contract on the destination chain with a message
    /// @param dstChain Destination chain for the swap
    /// @param dstAddress Address where the swapped tokens will be sent to on the destination chain
    /// @param dstToken Chainflip specific token identifier on the destination chain
    /// @param message Message that is passed to the destination address on the destination chain
    /// @param gasAmount Gas budget for the call on the destination chain
    /// @param cfParameters Additional metadata for future features
    function xCallNative(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        bytes calldata message,
        uint256 gasAmount,
        bytes calldata cfParameters
    ) external payable;

    /// @notice Swaps ERC20 token and calls a contract on the destination chain with a message
    /// @param dstChain Destination chain for the swap
    /// @param dstAddress Address where the swapped tokens will be sent to on the destination chain
    /// @param dstToken Chainflip specific token identifier on the destination chain
    /// @param message Message that is passed to the destination address on the destination chain
    /// @param gasAmount Gas budget for the call on the destination chain
    /// @param srcToken Address of the token to be swapped from the source chain
    /// @param amount Amount of the source token to be swapped
    /// @param cfParameters Additional metadata for future features
    function xCallToken(
        uint32 dstChain,
        bytes calldata dstAddress,
        uint32 dstToken,
        bytes calldata message,
        uint256 gasAmount,
        IERC20 srcToken,
        uint256 amount,
        bytes calldata cfParameters
    ) external;
}
