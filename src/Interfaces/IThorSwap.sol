// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @title ThorSwap Interface
interface IThorSwap {
    // Uniswap Style Aggregartors
    function swapIn(
        address tcRouter,
        address tcVault,
        string calldata tcMemo,
        address token,
        uint256 amount,
        uint256 amountOutMin,
        uint256 deadline
    ) external;

    // Generic Aggregator
    function swapIn(
        address tcRouter,
        address tcVault,
        string calldata tcMemo,
        address token,
        uint256 amount,
        address router,
        bytes calldata data,
        uint256 deadline
    ) external;

    // Thorchain router
    function depositWithExpiry(
        address vault,
        address asset,
        uint256 amount,
        string calldata memo,
        uint256 expiration
    ) external payable;
}
