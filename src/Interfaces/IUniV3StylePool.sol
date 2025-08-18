// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IUniV3LikePool
/// @author LI.FI (https://li.fi)
/// @notice Interface for UniV3-style pools
/// @custom:version 1.0.0
interface IUniV3LikePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
}
