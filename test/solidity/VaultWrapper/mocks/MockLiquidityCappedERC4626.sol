// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";

/// @notice Compliant ERC-4626 modelling an Aave-style withdrawal-liquidity cap: all deposited
///         assets stay on the vault (so `totalAssets` and price-per-share are unchanged), but
///         only `withdrawableAssets` of value may leave via `withdraw`/`redeem` at any moment.
///         `maxWithdraw`/`maxRedeem` report the cap and the mutating paths revert past it, so a
///         caller that respects the reported max never reverts. `setWithdrawable` moves the cap
///         up and down to fuzz shifting liquidity. Used to prove the wrapper's liquidity-aware
///         `max*` views. The cap is a policy limit, not a balance: the assets are always
///         physically present, so any within-cap exit succeeds.
contract MockLiquidityCappedERC4626 is MockERC4626 {
    error WithdrawExceedsLiquidity();

    uint256 public withdrawableAssets;

    constructor(
        ERC20 _asset,
        string memory _name,
        string memory _symbol
    ) MockERC4626(_asset, _name, _symbol) {}

    function setWithdrawable(uint256 _assets) external {
        withdrawableAssets = _assets;
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        uint256 own = convertToAssets(balanceOf[owner]);
        return own < withdrawableAssets ? own : withdrawableAssets;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 capShares = convertToShares(withdrawableAssets);
        uint256 own = balanceOf[owner];
        return own < capShares ? own : capShares;
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256) {
        if (assets > maxWithdraw(owner)) revert WithdrawExceedsLiquidity();

        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256) {
        if (shares > maxRedeem(owner)) revert WithdrawExceedsLiquidity();

        return super.redeem(shares, receiver, owner);
    }
}
