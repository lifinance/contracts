// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Curve
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ICurveLegacy {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        // solhint-disable-next-line var-name-mixedcase
        uint256 min_dy
    ) external payable;
}
