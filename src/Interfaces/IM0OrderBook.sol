// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IM0OrderBook
/// @author LI.FI (https://li.fi)
/// @notice Interface for the M0 OrderBook, an escrow-based limit order book filled by solvers
/// @custom:version 1.0.0
interface IM0OrderBook {
    /// @notice Describes a single limit order
    /// @param destChainId Chain the order is filled on. Equals the origin chain for same-chain orders.
    /// @param fillDeadline Unix timestamp after which the order can no longer be filled
    /// @param tokenIn Token escrowed on the origin chain. Fee-on-transfer tokens are rejected
    ///        by the OrderBook because it pulls the amount with an exact-balance transfer.
    /// @param tokenOut Token delivered on the destination chain, bytes32 to cover non-EVM chains
    /// @param amountIn Amount of tokenIn pulled from the funder and held in escrow
    /// @param amountOut Amount of tokenOut the order asks for. This is a limit price, not a
    ///        slippage floor: partial fills release tokenIn pro rata at this exchange rate.
    /// @param recipient Destination-chain receiver of tokenOut, bytes32 to cover non-EVM chains
    /// @param solver Solver exclusively allowed to fill the order; bytes32(0) opens it to all solvers
    /// @param sender Order owner. Always receives the origin-chain refund when the order is
    ///        cancelled. Cancellation is processed on the destination chain, so before
    ///        `fillDeadline` this address may cancel only when the order is same-chain;
    ///        on a cross-chain order only `recipient` may. After `fillDeadline` anyone may.
    struct OrderParams {
        uint32 destChainId;
        uint32 fillDeadline;
        address tokenIn;
        bytes32 tokenOut;
        uint128 amountIn;
        uint128 amountOut;
        bytes32 recipient;
        bytes32 solver;
        address sender;
    }

    /// @notice Escrows amountIn of tokenIn from msg.sender and opens a fillable order
    /// @param orderParams The order to open
    /// @return orderId Identifier of the opened order
    function openOrder(
        OrderParams calldata orderParams
    ) external returns (bytes32 orderId);

    /// @notice Whether an order opened on this chain may target destChainId
    /// @dev Returns true unconditionally when destChainId is the local chain, which is how
    ///      the OrderBook admits same-chain orders.
    /// @param destChainId The destination chain to check
    /// @return Whether the destination is supported
    function isDestinationSupported(
        uint32 destChainId
    ) external view returns (bool);
}
