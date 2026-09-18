// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";

/// @notice ERC-4626 modelling a MetaMorpho-style supply cap on the entry axis: an
///         asset-denominated `depositCap` bounds the total assets the source will hold, so
///         `maxDeposit` reports the remaining headroom and `deposit`/`mint` revert past it,
///         while the exit axis stays unrestricted. The entry-side mirror of
///         MockWithdrawCappedERC4626; used to prove the wrapper folds the source's inflow cap
///         into `maxDeposit`/`maxMint` so a caller that respects the reported max never
///         reverts. `setDepositCap` moves the cap to fuzz shifting capacity; a cap of
///         `type(uint256).max` models an uncapped source.
contract MockDepositCappedERC4626 is MockERC4626 {
    error DepositExceedsCap();

    uint256 public depositCap = type(uint256).max;

    constructor(
        ERC20 _asset,
        string memory _name,
        string memory _symbol
    ) MockERC4626(_asset, _name, _symbol) {}

    function setDepositCap(uint256 _assets) external {
        depositCap = _assets;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (depositCap == type(uint256).max) return type(uint256).max;

        uint256 held = totalAssets();
        return held < depositCap ? depositCap - held : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assetCap = maxDeposit(receiver);
        if (assetCap == type(uint256).max) return type(uint256).max;

        return convertToShares(assetCap);
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override returns (uint256) {
        if (assets > maxDeposit(receiver)) revert DepositExceedsCap();

        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override returns (uint256) {
        if (shares > maxMint(receiver)) revert DepositExceedsCap();

        return super.mint(shares, receiver);
    }
}
