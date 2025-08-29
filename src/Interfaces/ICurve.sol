// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Curve
/// @author LI.FI (https://li.fi)
/// @notice Minimal Curve pool interface for exchange operations
/// @custom:version 1.0.0
interface ICurve {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external payable;
}
