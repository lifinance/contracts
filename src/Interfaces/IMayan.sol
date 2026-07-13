// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Mayan
/// @author LI.FI (https://li.fi)
/// @custom:version 1.1.0
interface IMayan {
    struct PermitParams {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function forwardEth(
        address mayanProtocol,
        bytes calldata protocolData
    ) external payable;

    /// @notice Swaps the sent native token into a middle token via the given swap
    ///         protocol, then forwards the result to a Mayan protocol for bridging.
    /// @param amountIn The amount of native token to swap and forward.
    /// @param swapProtocol The protocol used to swap the native input into middleToken.
    /// @param swapData The calldata passed to swapProtocol to perform the swap.
    /// @param middleToken The token the native input is swapped into before forwarding.
    /// @param minMiddleAmount The minimum middleToken amount required from the swap.
    /// @param mayanProtocol The address of the Mayan protocol final contract.
    /// @param mayanData The protocol data forwarded to the Mayan protocol.
    function swapAndForwardEth(
        uint256 amountIn,
        address swapProtocol,
        bytes calldata swapData,
        address middleToken,
        uint256 minMiddleAmount,
        address mayanProtocol,
        bytes calldata mayanData
    ) external payable;

    function forwardERC20(
        address tokenIn,
        uint256 amountIn,
        PermitParams calldata permitParams,
        address mayanProtocol,
        bytes calldata protocolData
    ) external payable;
}
