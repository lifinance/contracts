// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Transfer Event Emitter
/// @author LI.FI (https://li.fi)
/// @notice "Dumb" contract that simply emits events for simple same chain
/// transfers. Used for tracking purposes.
/// @custom:version 1.0.0
contract TransferEventEmitter {
    /// Events

    event TokensTransferred();

    // @notice emits a transfer event
    function emitTransferEvent() external {
        emit TokensTransferred();
    }
}
