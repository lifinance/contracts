// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for Teleport Gateway
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ITeleportGateway {
    /// @notice Initiate DAI transfer.
    /// @param targetDomain Domain of destination chain.
    /// @param receiver Receiver address.
    /// @param amount The amount of DAI to transfer.
    function initiateTeleport(
        bytes32 targetDomain,
        address receiver,
        uint128 amount
    ) external;
}
