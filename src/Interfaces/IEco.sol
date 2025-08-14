// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IEco Interface
/// @notice Interface for Eco Protocol's intent system
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IEco {
    /// @notice Route struct containing source and destination information
    struct Route {
        address source;
        uint256 destination;
        bytes data;
    }

    /// @notice Reward struct containing token distribution details
    struct Reward {
        address prover;
        address[] tokens;
        uint256[] amounts;
        uint256 deadline;
        uint256 nonce;
    }

    /// @notice Complete intent struct
    struct Intent {
        Route route;
        Reward reward;
    }

    /// @notice Creates and funds an intent in a single transaction
    /// @param intent The complete intent struct to be published and funded
    /// @param allowPartial Whether to allow partial fulfillment
    /// @return intentHash Hash of the created and funded intent
    function publishAndFund(
        Intent calldata intent,
        bool allowPartial
    ) external payable returns (bytes32 intentHash);

    /// @notice Creates an intent without funding (optional, for solver discovery)
    /// @param intent The complete intent struct to be published
    /// @return intentHash Hash of the created intent
    function publish(
        Intent calldata intent
    ) external returns (bytes32 intentHash);

    /// @notice Funds an existing intent
    /// @param routeHash Hash of the route component
    /// @param reward Reward structure containing distribution details
    /// @param allowPartial Whether to allow partial fulfillment
    /// @return intentHash Hash of the funded intent
    function fund(
        bytes32 routeHash,
        Reward calldata reward,
        bool allowPartial
    ) external payable returns (bytes32 intentHash);
}