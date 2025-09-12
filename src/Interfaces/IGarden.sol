// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IGarden Interface
/// @notice Interface for Garden HTLC contracts
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IGarden {
    /// @notice Initiate HTLC on behalf of initiator
    /// @param initiator The address initiating the HTLC (user who will receive refund if HTLC expires)
    /// @param redeemer The address that will receive the funds (solver/filler on source chain)
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

/// @title IGardenRegistry Interface
/// @notice Interface for the Garden Registry contract
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IGardenRegistry {
    /// @notice Get HTLC address for a given asset
    /// @param assetId The asset address (use address(0) for native)
    /// @return The HTLC contract address for the asset
    function htlcs(address assetId) external view returns (address);
}
