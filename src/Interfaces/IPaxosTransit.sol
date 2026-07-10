// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IPaxosTransit
/// @author LI.FI (https://li.fi)
/// @notice Interface for the Paxos Transit station used to submit cross-chain transit orders
/// @custom:version 1.0.0
interface IPaxosTransit {
    /// @notice Routing information for a transit order
    /// @param destEID The LayerZero endpoint id of the destination chain
    /// @param offerAsset The asset provided on the source chain (ERC20 only)
    /// @param wantAsset The asset to be received on the destination chain
    struct Route {
        uint32 destEID;
        address offerAsset;
        address wantAsset;
    }

    /// @notice A Paxos-signed transit quote with a fixed, locked exchange rate
    /// @param route Routing information (destination EID, offer / want assets)
    /// @param offerAmount The amount of offerAsset provided by the payer (pulled from msg.sender)
    /// @param receiver The address that receives the wantAsset on the destination chain
    /// @param protocolFee The protocol fee enforced by Transit (denominated in offerAsset)
    /// @param integratorFee Optional integrator fee (denominated in offerAsset)
    /// @param integratorFeeReceiver Recipient of the integrator fee
    /// @param distributorCode Left-adjusted bytes32 distributor identifier
    /// @param deadline Unix timestamp after which the quote is no longer valid
    /// @param salt Unique salt that makes each quote digest unique
    struct Quote {
        Route route;
        uint256 offerAmount;
        address receiver;
        uint256 protocolFee;
        uint256 integratorFee;
        address integratorFeeReceiver;
        bytes32 distributorCode;
        uint256 deadline;
        bytes32 salt;
    }

    /// @notice Submits a signed transit order, pulling offerAmount of offerAsset from msg.sender.
    ///         The wantAsset is delivered to quote.receiver regardless of who submits the order.
    /// @param quote The Paxos-signed quote describing the order
    /// @param signature The Paxos signature over the EIP-712 quote digest
    /// @return uuid The order id (the EIP-712 digest of the signed quote)
    function submitOrder(
        Quote calldata quote,
        bytes calldata signature
    ) external payable returns (bytes32 uuid);
}
