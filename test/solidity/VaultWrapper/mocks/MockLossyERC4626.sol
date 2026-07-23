// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice STANDARD ERC-4626 vault with an exit fee: previews are honest (previewRedeem
///         nets the fee, previewWithdraw grosses shares up) and withdraw/redeem deliver
///         exactly what the previews promise. Fee assets stay in the vault. Models an
///         underlying that adds an exit fee after wrapper deployment.
contract MockLossyERC4626 is ERC4626 {
    uint256 internal constant BPS = 10_000;
    uint256 public immutable EXIT_FEE_BPS;

    error FeeTooHigh();

    constructor(
        ERC20 _asset,
        uint256 _exitFeeBps
    ) ERC4626(_asset, "Lossy Vault", "lossyTKN") {
        if (_exitFeeBps >= BPS) revert FeeTooHigh();
        EXIT_FEE_BPS = _exitFeeBps;
    }

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function previewRedeem(
        uint256 shares
    ) public view override returns (uint256 assets) {
        assets = super.previewRedeem(shares);
        assets -= (assets * EXIT_FEE_BPS) / BPS;
    }

    function previewWithdraw(
        uint256 assets
    ) public view override returns (uint256) {
        // Gross the exact-out request up so the net-of-fee payout equals `assets`.
        uint256 gross = (assets * BPS + (BPS - EXIT_FEE_BPS) - 1) /
            (BPS - EXIT_FEE_BPS);
        return super.previewWithdraw(gross);
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        return
            (super.previewRedeem(balanceOf[owner]) * (BPS - EXIT_FEE_BPS)) /
            BPS;
    }
}
