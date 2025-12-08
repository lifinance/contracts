// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for ERC20Proxy
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IERC20Proxy {
    function transferFrom(
        address tokenAddress,
        address from,
        address to,
        uint256 amount
    ) external;
}
