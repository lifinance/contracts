// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "./TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ZeroAmount } from "../Errors/GenericErrors.sol";

/// @title WithdrawablePeriphery
/// @author LI.FI (https://li.fi)
/// @notice Abstract helper that lets the contract owner withdraw native ETH or ERC20 tokens
///         held by the periphery. Child contracts may temporarily custody user funds during
///         execution; any lingering balance can be recovered via `withdrawToken` by the owner.
///         This contract is not intended as a long-term custody vault; balances should not
///         persist beyond operational needs.
/// @custom:version 2.0.0
abstract contract WithdrawablePeriphery is TransferrableOwnership {
    event TokensWithdrawn(
        address assetId,
        address payable receiver,
        uint256 amount
    );

    /// @notice Initializes withdrawable periphery ownership
    /// @param _owner The initial owner address
    constructor(address _owner) TransferrableOwnership(_owner) {}

    /// @notice Withdraws native or ERC20 tokens held by this contract to a receiver
    /// @param assetId Token address (`address(0)` for native) to withdraw
    /// @param receiver Recipient of the withdrawn tokens or ETH
    /// @param amount Amount to withdraw (must be greater than zero)
    function withdrawToken(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (amount == 0) revert ZeroAmount();

        LibAsset.transferAsset(assetId, receiver, amount);

        emit TokensWithdrawn(assetId, receiver, amount);
    }
}
