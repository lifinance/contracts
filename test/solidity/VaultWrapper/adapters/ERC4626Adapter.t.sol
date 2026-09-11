// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";
import { MockERC4626Underlying } from "../mocks/MockERC4626Underlying.sol";
import { MockLiquidityCappedERC4626 } from "../mocks/MockLiquidityCappedERC4626.sol";
import { MockWithdrawCappedERC4626 } from "../mocks/MockWithdrawCappedERC4626.sol";

contract ERC4626AdapterTest is Test {
    ERC4626Adapter internal adapter;
    address internal assetToken = makeAddr("asset");
    MockERC20 internal asset;
    MockERC4626 internal vault;

    function setUp() public {
        adapter = new ERC4626Adapter();
        asset = new MockERC20("Token", "TKN", 18);
        vault = new MockERC4626(asset, "Yield Token", "yTKN");
    }

    function test_ResolveAssetReturnsAssetForValidVault() public {
        MockERC4626Underlying resolveVault = new MockERC4626Underlying(
            assetToken
        );
        assertEq(adapter.resolveAsset(address(resolveVault)), assetToken);
    }

    function test_ResolveAssetRevertsOnNoCode() public {
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(makeAddr("eoa"));
    }

    function test_ResolveAssetRevertsOnZeroAsset() public {
        MockERC4626Underlying zeroAssetVault = new MockERC4626Underlying(
            address(0)
        );
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(address(zeroAssetVault));
    }

    function test_MaxWithdrawableValueEqualsPositionWhenUnlimited() public {
        asset.mint(address(this), 1_000e18);
        asset.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18, address(this));

        assertEq(
            adapter.maxWithdrawableValue(address(vault), address(this)),
            1_000e18
        );
    }

    function test_MaxWithdrawableValueIsZeroForEmptyHolder() public {
        assertEq(
            adapter.maxWithdrawableValue(address(vault), makeAddr("nobody")),
            0
        );
    }

    function test_MaxWithdrawableValueCapsAtSourceLiquidity() public {
        MockLiquidityCappedERC4626 capped = new MockLiquidityCappedERC4626(
            asset,
            "Capped",
            "cTKN"
        );
        asset.mint(address(this), 1_000e18);
        asset.approve(address(capped), 1_000e18);
        capped.deposit(1_000e18, address(this));
        capped.setWithdrawable(300e18);

        // Position is worth 1_000e18 but only 300e18 is currently withdrawable.
        assertEq(
            adapter.maxWithdrawableValue(address(capped), address(this)),
            300e18
        );
    }

    function test_MaxWithdrawableValueClampsToWithdrawAxis() public {
        MockWithdrawCappedERC4626 capped = new MockWithdrawCappedERC4626(
            asset,
            "WithdrawCapped",
            "wcTKN"
        );
        asset.mint(address(this), 1_000e18);
        asset.approve(address(capped), 1_000e18);
        capped.deposit(1_000e18, address(this));
        capped.setWithdrawCap(300e18);

        // maxRedeem is unrestricted (full balance, worth 1_000e18), but withdraw is capped
        // at 300e18. The adapter must report the withdraw-axis limit, since the wrapper
        // exits via `withdraw`; reading maxRedeem alone would over-report 1_000e18.
        assertEq(
            capped.convertToAssets(capped.maxRedeem(address(this))),
            1_000e18
        );
        assertEq(
            adapter.maxWithdrawableValue(address(capped), address(this)),
            300e18
        );
    }

    function testRevert_DirectDepositCall() public {
        vm.expectRevert(ERC4626Adapter.DirectCallNotAllowed.selector);

        adapter.deposit(address(asset), address(vault), 1e18);
    }

    function testRevert_DirectWithdrawCall() public {
        vm.expectRevert(ERC4626Adapter.DirectCallNotAllowed.selector);

        adapter.withdraw(address(asset), address(vault), 1e18);
    }
}
