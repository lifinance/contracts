// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice ERC-4626 vault that is BOTH lossy (charges an exit fee, exported to an
///         external sink) AND withdrawal-liquidity-capped, combined in one mock so exit-
///         limit tests can exercise both constraints on the same source at once.
///         `maxWithdraw` reports the smaller of the fee-net owned value and the
///         liquidity cap (mirrors `MockCappedERC4626`'s min); `beforeWithdraw` enforces
///         the liquidity cap on execution and exports the fee-equivalent value exactly
///         as `MockLossyERC4626.beforeWithdraw` does.
contract MockLossyCappedERC4626 is ERC4626 {
    uint256 internal constant BPS = 10_000;
    uint256 public immutable EXIT_FEE_BPS;
    address public constant EXIT_FEE_SINK = address(0xFEE5);
    uint256 public liquidity = type(uint256).max;

    error FeeTooHigh();
    error InsufficientLiquidity();

    constructor(
        ERC20 _asset,
        uint256 _exitFeeBps
    ) ERC4626(_asset, "Lossy Capped Vault", "lcTKN") {
        if (_exitFeeBps >= BPS) revert FeeTooHigh();
        EXIT_FEE_BPS = _exitFeeBps;
    }

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function setLiquidity(uint256 _liquidity) external {
        liquidity = _liquidity;
    }

    /// @dev Enforces the liquidity cap on the requested delivery (mirrors
    ///      `MockCappedERC4626.beforeWithdraw`), then exports the fee-equivalent value
    ///      exactly as `MockLossyERC4626.beforeWithdraw` does.
    function beforeWithdraw(uint256 assets, uint256 shares) internal override {
        if (assets > liquidity) revert InsufficientLiquidity();

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

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        uint256 owned = (super.previewRedeem(balanceOf[owner]) *
            (BPS - EXIT_FEE_BPS)) / BPS;
        return owned < liquidity ? owned : liquidity;
    }
}
