// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IERC20Proxy {
    function transferFrom(
        address tokenAddress,
        address from,
        address to,
        uint256 amount
    ) external;
}
