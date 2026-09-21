// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";

/// @notice ERC-4626 whose withdraw axis is capped tighter than its redeem axis: an
///         asset-denominated `withdrawCap` bounds `maxWithdraw` and reverts `withdraw`
///         past it, while `maxRedeem`/`redeem` stay unrestricted. EIP-4626 permits the two
///         limits to diverge, so `convertToAssets(maxRedeem)` can exceed `maxWithdraw`.
///         MockLiquidityCappedERC4626 cannot model this (it derives both limits from one
///         cap); this source exists to prove the adapter must read the withdraw axis,
///         since the wrapper always exits via `withdraw`.
contract MockWithdrawCappedERC4626 is MockERC4626 {
    error WithdrawExceedsCap();

    uint256 public withdrawCap;

    constructor(
        ERC20 _asset,
        string memory _name,
        string memory _symbol
    ) MockERC4626(_asset, _name, _symbol) {}

    function setWithdrawCap(uint256 _assets) external {
        withdrawCap = _assets;
    }

    function maxWithdraw(
        address owner
    ) public view override returns (uint256) {
        uint256 own = convertToAssets(balanceOf[owner]);
        return own < withdrawCap ? own : withdrawCap;
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override returns (uint256) {
        if (assets > maxWithdraw(owner)) revert WithdrawExceedsCap();

        return super.withdraw(assets, receiver, owner);
    }
}
