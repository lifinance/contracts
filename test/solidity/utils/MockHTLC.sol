// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IHTLC
/// @notice Mock interface for HTLC (Hash Time Lock Contract) used in testing
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IHTLC {
    /// @notice Refund locked funds after timelock expires
    /// @param orderID The ID of the HTLC order
    function refund(bytes32 orderID) external;

    /// @notice Get details of an HTLC order
    /// @param orderID The ID of the HTLC order
    /// @return initiator Address that can claim refund
    /// @return redeemer Address that can redeem with secret
    /// @return timelock Block number when refund becomes available
    /// @return amount Amount locked
    /// @return secretHash Hash of the secret
    /// @return completed Whether the order has been completed
    /// @return refunded Whether the order has been refunded
    function orders(
        bytes32 orderID
    )
        external
        view
        returns (
            address initiator,
            address redeemer,
            uint256 timelock,
            uint256 amount,
            bytes32 secretHash,
            bool completed,
            bool refunded
        );
}

/// @title MockHTLC
/// @notice Mock HTLC contract for testing purposes
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
contract MockHTLC is IHTLC {
    error OrderDoesNotExist();
    error OrderAlreadyCompleted();
    error OrderAlreadyRefunded();
    error TimelockNotExpired();
    error OnlyInitiatorCanRefund();

    struct Order {
        address initiator;
        address redeemer;
        uint256 timelock;
        uint256 amount;
        bytes32 secretHash;
        bool completed;
        bool refunded;
    }

    mapping(bytes32 => Order) public orders;

    /// @notice Refund locked funds after timelock expires
    /// @param orderID The ID of the HTLC order
    function refund(bytes32 orderID) external {
        Order storage order = orders[orderID];
        if (order.initiator == address(0)) revert OrderDoesNotExist();
        if (order.completed) revert OrderAlreadyCompleted();
        if (order.refunded) revert OrderAlreadyRefunded();
        if (block.number < order.timelock) revert TimelockNotExpired();
        if (msg.sender != order.initiator) revert OnlyInitiatorCanRefund();

        order.refunded = true;
        // In a real implementation, this would transfer funds
        // For testing, we just mark it as refunded
    }

    /// @notice Helper function to create an order for testing
    /// @param orderID The ID of the HTLC order
    /// @param initiator Address that can claim refund
    /// @param redeemer Address that can redeem with secret
    /// @param timelock Block number when refund becomes available
    /// @param amount Amount locked
    /// @param secretHash Hash of the secret
    function createOrder(
        bytes32 orderID,
        address initiator,
        address redeemer,
        uint256 timelock,
        uint256 amount,
        bytes32 secretHash
    ) external {
        orders[orderID] = Order({
            initiator: initiator,
            redeemer: redeemer,
            timelock: timelock,
            amount: amount,
            secretHash: secretHash,
            completed: false,
            refunded: false
        });
    }
}
