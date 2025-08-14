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

    /// @notice Complete intent struct
    struct Intent {
        uint64 destination;
        Route route;
        Reward reward;
    }

    /// @notice Creates an intent without funding (optional, for solver discovery)
    /// @param destination Target chain ID
    /// @param route Execution instructions for destination chain
    /// @param reward Incentive structure for solvers
    /// @return intentHash Hash of the created intent
    /// @return vault Address of the deterministic vault for this intent
    function publish(
        uint64 destination,
        Route calldata route,
        Reward calldata reward
    ) external returns (bytes32 intentHash, address vault);

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

    /// @notice Executes intent on destination chain
    /// @param intentHash Hash of the intent to fulfill
    /// @param route Route data for execution
    /// @param rewardHash Hash of the reward component
    /// @param claimant Address to receive rewards
    /// @return results Array of return data from executed calls
    function fulfill(
        bytes32 intentHash,
        Route calldata route,
        bytes32 rewardHash,
        address claimant
    ) external returns (bytes[] memory results);

    /// @notice Submit cross-chain proof of fulfillment
    /// @param prover Address of the prover contract
    /// @param sourceChainDomainID Source chain domain identifier
    /// @param intentHashes Array of intent hashes being proven
    /// @param data Encoded proof data
    function prove(
        address prover,
        uint64 sourceChainDomainID,
        bytes32[] calldata intentHashes,
        bytes calldata data
    ) external;

    /// @notice Claim rewards after proof submission
    /// @param destination Target chain ID
    /// @param routeHash Hash of the route component
    /// @param reward Reward structure
    function withdraw(
        uint64 destination,
        bytes32 routeHash,
        Reward calldata reward
    ) external;

    /// @notice Reclaim rewards if intent expires
    /// @param destination Target chain ID
    /// @param routeHash Hash of the route component
    /// @param reward Reward structure
    function refund(
        uint64 destination,
        bytes32 routeHash,
        Reward calldata reward
    ) external;
}
