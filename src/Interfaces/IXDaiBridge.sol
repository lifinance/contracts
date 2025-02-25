// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for XDaiBridge
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0

interface IXDaiBridge {
    /// @notice Bridge Dai to xDai and sends to receiver
    /// @dev It's implemented in xDaiBridge on only Ethereum
    /// @param receiver Receiver address
    /// @param amount Dai amount
    function relayTokens(address receiver, uint256 amount) external;
}
