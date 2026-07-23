// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";

/// @notice NON-STANDARD ERC-4626 vault: previews promise the full amount but every
///         exit delivers `SHORTFALL` wei less (e.g. a fee-on-transfer asset or a
///         misbehaving source). Exercises the wrapper's strict exact-out guard and
///         the loss-tolerant redeem pass-through.
contract MockShortPayingERC4626 is ERC4626 {
    uint256 public constant SHORTFALL = 1;

    error ZeroAssets();
    error TransferFailed();

    constructor(
        ERC20 _asset
    ) ERC4626(_asset, "ShortPaying Vault", "shortTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256 shares) {
        shares = previewWithdraw(assets);
        _useAllowance(owner, shares);
        _burn(owner, shares);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        _shortPay(receiver, assets);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256 assets) {
        assets = previewRedeem(shares);
        if (assets == 0) revert ZeroAssets();
        _useAllowance(owner, shares);
        _burn(owner, shares);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        _shortPay(receiver, assets);
    }

    function _useAllowance(address owner, uint256 shares) private {
        if (msg.sender == owner) return;
        uint256 allowed = allowance[owner][msg.sender];
        if (allowed != type(uint256).max)
            allowance[owner][msg.sender] = allowed - shares;
    }

    function _shortPay(address receiver, uint256 assets) private {
        uint256 paid = assets > SHORTFALL ? assets - SHORTFALL : 0;
        if (!asset.transfer(receiver, paid)) revert TransferFailed();
    }
}
