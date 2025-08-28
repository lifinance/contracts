// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IGarden Interface
/// @notice Interface for Garden HTLC contracts
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IGarden {
    /// @notice Initiate HTLC on behalf of initiator
    /// @param initiator The address initiating the HTLC (will be LiFiDiamond)
    /// @param redeemer The address that can redeem on destination chain
    /// @param timelock Block number when refund becomes available
    /// @param amount Amount of tokens to lock
    /// @param secretHash SHA256 hash of the secret
    function initiateOnBehalf(
        address initiator,
        address redeemer,
        uint256 timelock,
        uint256 amount,
        bytes32 secretHash
    ) external payable;
}
