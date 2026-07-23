// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice STANDARD ERC-4626 vault with an exit fee: previews are honest (previewRedeem
///         nets the fee, previewWithdraw grosses shares up) and withdraw/redeem deliver
///         exactly what the previews promise. The fee-equivalent asset value is sent to
///         an external sink (`EXIT_FEE_SINK`), not retained as extra backing for the
///         vault's own remaining shares: a wrapper holding 100% of THIS vault's shares
///         would otherwise see the "fee" recycle straight back into its own remaining
///         position (since it is the sole beneficiary of any retained value), silently
///         masking the real-world case this mock exists to simulate — a shared,
///         multi-tenant vault where the exit fee genuinely leaves the wrapper's
///         aggregate claim (to other, non-wrapper depositors). Models an underlying
///         that adds an exit fee after wrapper deployment.
contract MockLossyERC4626 is ERC4626 {
    uint256 internal constant BPS = 10_000;
    uint256 public immutable EXIT_FEE_BPS;
    address public constant EXIT_FEE_SINK = address(0xFEE5);

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

    /// @dev Skims the fee-equivalent asset value out of the vault BEFORE the burn/payout
    ///      that both `withdraw` and `redeem` route through, so it genuinely leaves this
    ///      vault's balance instead of inflating the PPS of whichever shares remain. Both
    ///      callers pass a `(assets, shares)` pair priced at the SAME pre-burn ratio (the
    ///      overridden `previewWithdraw`/`previewRedeem`), so `super.previewMint(shares)`
    ///      (the RAW, non-fee value of the shares being burned) minus `assets` (the
    ///      fee-net amount being paid) is exactly the fee.
    function beforeWithdraw(uint256 assets, uint256 shares) internal override {
        uint256 grossValue = super.previewMint(shares);
        if (grossValue > assets) {
            asset.transfer(EXIT_FEE_SINK, grossValue - assets);
        }
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

    /// @dev Derived from THIS contract's own overridden `previewRedeem` (not a
    ///      separately recomputed fee formula): a caller forward-verifying this value
    ///      against `previewRedeem`'s own full-drain quote (as
    ///      `LiFiVaultWrapper.maxRedeem` does) must see byte-identical numbers, or an
    ///      off-the-fee-grid balance can make two independently-rounded formulas for
    ///      the "same" fee-net value disagree by a wei with no real liquidity
    ///      shortfall behind it.
    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        return previewRedeem(balanceOf[owner]);
    }
}
