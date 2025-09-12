// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IEcoPortal
/// @notice Interface for Eco Protocol IntentSource
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IEcoPortal {
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    struct TokenAmount {
        address token;
        uint256 amount;
    }

    struct Route {
        bytes32 salt;
        uint256 source;
        uint256 destination;
        address inbox;
        TokenAmount[] tokens;
        Call[] calls;
    }

    struct Reward {
        address creator;
        address prover;
        uint256 deadline;
        uint256 nativeValue;
        TokenAmount[] tokens;
    }

    struct Intent {
        Route route;
        Reward reward;
    }

    function publishAndFund(
        Intent calldata intent,
        bool allowPartial
    ) external payable returns (bytes32 intentHash);
}
