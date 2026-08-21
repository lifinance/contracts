// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";

/// @title ERC4626Adapter
/// @author LI.FI (https://li.fi)
/// @notice Yield adapter for standard ERC-4626 vaults: resolves the underlying's ERC20
///         asset and routes a vault wrapper's deposits, withdrawals, and valuation
///         through the ERC-4626 interface.
/// @dev Stateless: holds no storage, so the `deposit`/`withdraw` methods are safe to
///      `delegatecall` from a wrapper (they run in the wrapper's context and act only on
///      their arguments). `resolveAsset`/`totalAssets` are ordinary view calls.
///      This contract is not intended to custody funds; under `delegatecall` the assets
///      and yield-source shares belong to the calling wrapper. `deposit`/`withdraw` are
///      `onlyDelegateCall` — a direct call reverts `DirectCallNotAllowed`, so the adapter
///      never runs `forceApprove` in its own (fund-less) context and cannot be made to
///      grant a stray allowance from the shared singleton.
///      Assumes a STANDARD ERC-4626 (deposit consumes exactly the requested assets,
///      withdraw returns exactly the requested assets) over a non-fee-on-transfer asset.
///      `deposit`/`withdraw` return the wrapper's asset balance delta and the wrapper
///      reverts on a shortfall, which catches a yield source that moves less than asked.
///      It does NOT catch share-side dilution (a vault that consumes the full asset but
///      credits fewer shares via an internal deposit fee) — measuring that cleanly is
///      rounding-sensitive; such non-standard sources are unsupported and require a
///      dedicated adapter rather than this reference one.
/// @custom:version 2.0.0
contract ERC4626Adapter is IYieldAdapter {
    /// @dev This adapter's own deployed address, captured at construction. Under
    ///      `delegatecall` the running `address(this)` is the calling wrapper, so it
    ///      never equals `SELF`; a direct call to the deployed adapter does — which is
    ///      how `onlyDelegateCall` tells the two apart.
    address private immutable SELF = address(this);

    /// @notice Thrown when a `delegatecall`-only method is invoked directly on the
    ///         deployed adapter.
    error DirectCallNotAllowed();

    /// @dev Restricts a method to the `delegatecall` path. A direct call runs with
    ///      `address(this) == SELF` and is rejected; under `delegatecall` the wrapper's
    ///      address differs from `SELF` and the call proceeds. Guards `deposit`/`withdraw`
    ///      only: without it a direct call runs `forceApprove` in the adapter's own
    ///      context, planting an attacker-chosen allowance from the shared singleton.
    modifier onlyDelegateCall() {
        if (address(this) == SELF) revert DirectCallNotAllowed();
        _;
    }

    /// @inheritdoc IYieldAdapter
    function resolveAsset(
        address _underlying
    ) external view returns (address asset) {
        if (_underlying.code.length == 0) revert AssetResolutionFailed();
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
    ) external onlyDelegateCall returns (uint256 deposited) {
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
    ) external onlyDelegateCall returns (uint256 withdrawn) {
        uint256 balanceBefore = IERC20(_asset).balanceOf(address(this));
        IERC4626(_underlying).withdraw({
            assets: _assets,
            receiver: address(this),
            owner: address(this)
        });
        withdrawn = IERC20(_asset).balanceOf(address(this)) - balanceBefore;
    }

    /// @inheritdoc IYieldAdapter
    /// @dev The source's `maxWithdraw` for the holder — the assets it can honor on exit
    ///      right now, already capped by both the holder's position and the source's
    ///      current withdrawal liquidity. This is the exact axis the wrapper exits on: it
    ///      always redeems via exact-asset `IERC4626.withdraw`, which the source bounds by
    ///      `maxWithdraw`. The source's share-side `maxRedeem` is deliberately not consulted
    ///      — the wrapper never calls `redeem`, EIP-4626 lets the two limits diverge, and
    ///      only `maxWithdraw` governs whether an exit reverts; folding `maxRedeem` in could
    ///      only under-report an exit the source would honor. Equals the full position value
    ///      when the source imposes no active liquidity limit.
    function maxWithdrawableValue(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets) {
        assets = IERC4626(_underlying).maxWithdraw(_holder);
    }

    /// @inheritdoc IYieldAdapter
    /// @dev The source's `maxDeposit` for the holder — the assets it will accept on entry
    ///      right now, capped by any supply/inflow limit. Returns `type(uint256).max` when
    ///      the source imposes no cap (EIP-4626's own sentinel), which the wrapper passes
    ///      through so an uncapped source keeps reporting unlimited deposit capacity. The
    ///      wrapper always enters via exact-asset `IERC4626.deposit`, so `maxDeposit` — not
    ///      the source's share-side `maxMint` — is the axis that governs an entry revert.
    function maxDepositableValue(
        address _underlying,
        address _holder
    ) external view returns (uint256 assets) {
        assets = IERC4626(_underlying).maxDeposit(_holder);
    }
}
