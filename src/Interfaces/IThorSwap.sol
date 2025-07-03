// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Thorswap
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
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
