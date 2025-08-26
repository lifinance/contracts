// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Curve V2
/// @author LI.FI (https://li.fi)
/// @notice Minimal Curve V2 pool interface for exchange operations
/// @custom:version 1.0.0
interface ICurveV2 {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external;

    function exchange_received(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy,
        address receiver
    ) external;
}
