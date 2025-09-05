// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title BaseRouteConstants
/// @author LI.FI (https://li.fi)
/// @notice Base contract providing common constants for DEX facets
/// @dev Abstract contract with shared constants to avoid duplication across facets
/// @custom:version 1.0.0
abstract contract BaseRouteConstants {
    /// @dev Constant indicating swap direction from token0 to token1
    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;

    /// @dev A sentinel address (address(1)) used in the `from` parameter of a swap.
    /// It signals that the input tokens for the swap are already held by the
    /// receiving contract (e.g., from a previous swap in a multi-step route).
    /// This tells the facet to use its current token balance instead of
    /// pulling funds from an external address via `transferFrom`.
    address internal constant FUNDS_IN_RECEIVER = address(1);
}
