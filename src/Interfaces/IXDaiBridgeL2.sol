// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IXDaiBridgeL2 {
    /// @notice Bridge xDai to DAI and sends to receiver
    /// @dev It's implemented in xDaiBridge on only Gnosis
    /// @param receiver Receiver address
    function relayTokens(address receiver) external payable;
}
