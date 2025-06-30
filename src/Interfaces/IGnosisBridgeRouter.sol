// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

/// @title Interface for GnosisBridgeRouter
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IGnosisBridgeRouter {
    /// @notice An entry point contract for user to bridge any token from source chain
    /// @dev Directs route to relevant contract to perform token relaying
    /// @param token token to bridge
    /// @param receiver receiver of token on Gnosis Chain
    /// @param amount amount to receive on Gnosis Chain
    function relayTokens(
        address token,
        address receiver,
        uint256 amount
    ) external payable;
}
