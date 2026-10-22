// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "forge-std/interfaces/IERC20.sol";

/// @notice Stand-in bridge facet for the AttestedBridgeFacet unit tests: pulls tokens from the caller into the Diamond
/// @dev Runs by delegatecall from the Diamond, so `msg.sender` and `msg.value` are the gateway caller's.
///      Real bridge facets need a fork; AttestedBridgeFacet.fork.t.sol dispatches AcrossFacetV4.
contract MockBridgeFacet {
    error TransferFromFailed();

    event MockBridged(
        address indexed token,
        address indexed from,
        uint256 amount,
        uint256 value
    );

    /// @notice Pulls `_amount` of `_token` from the caller into the Diamond
    /// @dev Payable so tests can check where `msg.value` lands
    /// @param _token The token to pull
    /// @param _amount The amount to pull
    function bridge(address _token, uint256 _amount) external payable {
        bool ok = IERC20(_token).transferFrom(
            msg.sender,
            address(this),
            _amount
        );
        if (!ok) revert TransferFromFailed();

        emit MockBridged(_token, msg.sender, _amount, msg.value);
    }
}
