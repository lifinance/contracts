// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

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
///      withdraw returns exactly the requested assets) over a non-fee-on-transfer asset
///      for the strict `deposit`/`withdraw` pair. `deposit`/`withdraw` return the
///      wrapper's asset balance delta and the wrapper reverts on a shortfall, which
///      catches a yield source that moves less than asked. It does NOT catch share-side
///      dilution (a vault that consumes the full asset but credits fewer shares via an
///      internal deposit fee) — measuring that cleanly is rounding-sensitive; such
///      non-standard sources are unsupported and require a dedicated adapter rather than
///      this reference one.
///      The `*UpTo` pair and the fail-soft `max*` limit views are the degraded-mode
///      surface: they tolerate a source that charges exit fees, caps deposits, or limits
///      withdrawal liquidity, and report what the source can actually deliver rather than
///      assuming the strict standard above.
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

    /// @inheritdoc IYieldAdapter
    function maxDeposit(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets) {
        (bool ok, uint256 value) = _staticCallUint(
            _underlying,
            abi.encodeCall(IERC4626.maxDeposit, (_holder))
        );
        maxAssets = ok ? value : 0;
    }

    /// @inheritdoc IYieldAdapter
    function maxWithdraw(
        address _underlying,
        address _holder
    ) external view returns (uint256 maxAssets) {
        (bool ok, uint256 value) = _staticCallUint(
            _underlying,
            abi.encodeCall(IERC4626.maxWithdraw, (_holder))
        );
        maxAssets = ok ? value : 0;
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Uses `convertToShares` (floor), not `previewWithdraw` (which grosses shares
    ///      up on a source that charges an exit fee), so the exiter's own shares absorb
    ///      their source-side exit cost rather than diluting the remaining holders. See
    ///      `withdrawUpTo`, which MUST use the same basis for preview/execution parity.
    ///      `_assets == type(uint256).max` skips the conversion (which would overflow)
    ///      and targets the full position directly — see the interface NatSpec.
    function previewWithdrawUpTo(
        address _underlying,
        address _holder,
        uint256 _assets
    ) external view returns (uint256 assets) {
        IERC4626 source = IERC4626(_underlying);
        uint256 held = source.balanceOf(_holder);
        uint256 shares = _assets == type(uint256).max
            ? held
            : source.convertToShares(_assets);
        if (shares > held) shares = held;
        if (shares == 0) return 0;

        return source.previewRedeem(shares);
    }

    /// @inheritdoc IYieldAdapter
    function previewWithdrawCost(
        address _underlying,
        uint256 _assets
    ) external view returns (uint256 cost) {
        IERC4626 source = IERC4626(_underlying);

        // previewMint values the burned shares rounding UP, the conservative
        // direction for the wrapper (the exiter's cost is never understated).
        return source.previewMint(source.previewWithdraw(_assets));
    }

    /// @inheritdoc IYieldAdapter
    /// @dev Uses `convertToShares` (floor) as the share basis — see `previewWithdrawUpTo`
    ///      for why — so on an honest source this returns AT MOST `_assets`, never more.
    ///      After a heavy loss, a dust target can floor to shares whose redeemable value
    ///      itself floors to zero; standard sources (including solmate) revert a
    ///      zero-asset redeem, so that case is skipped rather than bubbling the revert —
    ///      `previewWithdrawUpTo` already reports 0 for it via the same `previewRedeem`
    ///      call, so preview/execution parity holds. `_assets == type(uint256).max`
    ///      skips the conversion (which would overflow) and targets the full position
    ///      directly — see the interface NatSpec.
    function withdrawUpTo(
        address _asset,
        address _underlying,
        uint256 _assets
    ) external returns (uint256 withdrawn) {
        IERC4626 source = IERC4626(_underlying);
        uint256 held = source.balanceOf(address(this));
        uint256 shares = _assets == type(uint256).max
            ? held
            : source.convertToShares(_assets);
        if (shares > held) shares = held;
        if (shares == 0) return 0;
        // Zero-value dust skip — see @dev above.
        if (source.previewRedeem(shares) == 0) return 0;

        uint256 balanceBefore = IERC20(_asset).balanceOf(address(this));
        source.redeem({
            shares: shares,
            receiver: address(this),
            owner: address(this)
        });
        withdrawn = IERC20(_asset).balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Fail-soft staticcall returning a uint256: `ok = false` on revert, missing
    ///      code, or malformed return data, so limit views can degrade to 0 instead of
    ///      bubbling a source failure into the wrapper's EIP-4626 `max*` views.
    function _staticCallUint(
        address _target,
        bytes memory _callData
    ) private view returns (bool ok, uint256 value) {
        (bool success, bytes memory ret) = _target.staticcall(_callData);
        if (!success || ret.length < 32) return (false, 0);

        return (true, abi.decode(ret, (uint256)));
    }
}
