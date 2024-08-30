// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

/// @title ThorSwap Interface
interface IThorSwap {
    // Thorchain router
    function depositWithExpiry(
        address vault,
        address asset,
        uint256 amount,
        string calldata memo,
        uint256 expiration
    ) external payable;
}
