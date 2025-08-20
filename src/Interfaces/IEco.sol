// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IEco Interface
/// @notice Interface for Eco Protocol's Routes cross-chain intent system
/// @author LI.FI (https://li.fi)
/// @custom:version 2.0.0
interface IEco {
    /// @notice Token amount structure
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    /// @notice Call structure for destination chain execution
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    /// @notice Route struct containing execution instructions
    struct Route {
        bytes32 salt;
        uint64 deadline;
        address portal;
        TokenAmount[] tokens;
        Call[] calls;
    }

    /// @notice Reward struct containing incentive structure
    struct Reward {
        uint64 deadline;
        address creator;
        address prover;
        uint256 nativeAmount;
        TokenAmount[] tokens;
    }

    /// @notice Funds an intent by escrowing rewards
    /// @param destination Target chain ID
    /// @param routeHash Hash of the route component
    /// @param reward Reward structure containing incentives
    /// @param allowPartial Whether to allow partial fulfillment
    /// @return intentHash Hash of the funded intent
    function fund(
        uint64 destination,
        bytes32 routeHash,
        Reward calldata reward,
        bool allowPartial
    ) external payable returns (bytes32 intentHash);
}
