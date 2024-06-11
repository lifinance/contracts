// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Proxy {
    function transferFrom(
        address tokenAddress,
        address from,
        address to,
        uint256 amount
    ) external;
}
