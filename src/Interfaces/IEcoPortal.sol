// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IEcoPortal
/// @notice Interface for Eco Protocol Portal
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IEcoPortal {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    struct Reward {
        uint64 deadline;
        address creator;
        address prover;
        uint256 nativeAmount;
        TokenAmount[] tokens;
    }

    function publishAndFund(
        uint64 destination,
        bytes memory route,
        Reward calldata reward,
        bool allowPartial
    ) external payable returns (bytes32 intentHash, address vault);
}
