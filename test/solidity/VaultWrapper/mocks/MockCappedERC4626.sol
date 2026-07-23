// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice ERC-4626 vault with a deposit cap and a withdrawal-liquidity cap, both
///         reported by its max* views and enforced on execution; the views can also be
///         toggled to revert, exercising the adapter's fail-soft fallback. Both caps are
///         per-call thresholds (the max single deposit/withdrawal amount), not
///         cumulative budgets that decrement as they're consumed.
contract MockCappedERC4626 is ERC4626 {
    uint256 public depositCap = type(uint256).max;
    uint256 public liquidity = type(uint256).max;
    bool public revertOnLimitViews;

    error LimitViewsDisabled();
    error InsufficientLiquidity();
    error DepositCapExceeded();

    constructor(ERC20 _asset) ERC4626(_asset, "Capped Vault", "capTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function setDepositCap(uint256 _cap) external {
        depositCap = _cap;
    }

    function setLiquidity(uint256 _liquidity) external {
        liquidity = _liquidity;
    }

    function setRevertOnLimitViews(bool _revert) external {
        revertOnLimitViews = _revert;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (revertOnLimitViews) revert LimitViewsDisabled();
        return depositCap;
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        if (revertOnLimitViews) revert LimitViewsDisabled();
        uint256 owned = convertToAssets(balanceOf[owner]);
        return owned < liquidity ? owned : liquidity;
    }

    function beforeWithdraw(uint256 assets, uint256) internal view override {
        if (assets > liquidity) revert InsufficientLiquidity();
    }

    function afterDeposit(uint256 assets, uint256) internal view override {
        if (assets > depositCap) revert DepositCapExceeded();
    }
}
