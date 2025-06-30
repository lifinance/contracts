// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

/// @title Interface for VelodromeV2 pool callee
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IVelodromeV2PoolCallee {
    function hook(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}
