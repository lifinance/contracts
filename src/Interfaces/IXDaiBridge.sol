// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IXDaiBridge {
    /// @notice Bridge Dai to xDai and sends to receiver
    /// @dev It's implemented in xDaiBridge on only Ethereum
    /// @param receiver Receiver address
    /// @param amount Dai amount
    function relayTokens(address receiver, uint256 amount) external;
}
