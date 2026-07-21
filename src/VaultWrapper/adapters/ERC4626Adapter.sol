// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { LibAsset } from "../../Libraries/LibAsset.sol";

/// @title ERC4626Adapter
/// @author LI.FI (https://li.fi)
/// @notice Yield adapter for standard ERC-4626 vaults: resolves the underlying's ERC20
///         asset and routes a vault wrapper's deposits, withdrawals, and valuation
///         through the ERC-4626 interface.
/// @dev Stateless: holds no storage, so the `deposit`/`withdraw` methods are safe to
///      `delegatecall` from a wrapper (they run in the wrapper's context and act only on
///      their arguments). `resolveAsset`/`totalAssets` are ordinary view calls.
///      This contract is not intended to custody funds; under `delegatecall` the assets
///      and yield-source shares belong to the calling wrapper, and a direct call holds
///      nothing.
///      Assumes a STANDARD ERC-4626 (deposit consumes exactly the requested assets,
///      withdraw returns exactly the requested assets) over a non-fee-on-transfer asset.
///      `deposit`/`withdraw` return the wrapper's asset balance delta and the wrapper
///      reverts on a shortfall, which catches a yield source that moves less than asked.
///      It does NOT catch share-side dilution (a vault that consumes the full asset but
///      credits fewer shares via an internal deposit fee) — measuring that cleanly is
///      rounding-sensitive; such non-standard sources are unsupported and require a
///      dedicated adapter rather than this reference one.
/// @custom:version 1.0.0
contract ERC4626Adapter is IYieldAdapter {
    /// @inheritdoc IYieldAdapter
    function resolveAsset(
        address _underlying
    ) external view returns (address asset) {
        if (!LibAsset.isContract(_underlying)) revert AssetResolutionFailed();
        asset = IERC4626(_underlying).asset();
        if (asset == address(0)) revert AssetResolutionFailed();
    }

    /// @inheritdoc IYieldAdapter
    function totalAssets(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets) {
        assets = IERC4626(_underlying).convertToAssets({
            shares: IERC4626(_underlying).balanceOf({ account: _holder })
        });
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Returns the asset actually consumed (the wrapper's balance delta), so the caller
    ///      can revert when the yield source pulls less than requested. See the contract-level
    ///      note on the standard-ERC-4626 assumption this measurement relies on.
    function deposit(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 deposited) {
        uint256 balanceBefore = IERC20(_asset).balanceOf(address(this));
        SafeERC20.forceApprove(IERC20(_asset), _underlying, _assets);
        IERC4626(_underlying).deposit({
            assets: _assets,
            receiver: address(this)
        });
        deposited = balanceBefore - IERC20(_asset).balanceOf(address(this));
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Returns the asset actually received (the wrapper's balance delta), not the
    ///      requested amount, so the caller can detect a short-paying yield source rather
    ///      than assume a 1:1 withdrawal.
    function withdraw(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn) {
        uint256 balanceBefore = IERC20(_asset).balanceOf(address(this));
        IERC4626(_underlying).withdraw({
            assets: _assets,
            receiver: address(this),
            owner: address(this)
        });
        withdrawn = IERC20(_asset).balanceOf(address(this)) - balanceBefore;
    }
}
