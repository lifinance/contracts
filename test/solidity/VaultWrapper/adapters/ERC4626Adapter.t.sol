// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";
import { MockERC4626Underlying } from "../mocks/MockERC4626Underlying.sol";

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

    function test_PreviewWithdrawCostEqualsAssetsWhenNoFee() public {
        asset.mint(address(this), 1_000e18);
        asset.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18, address(this));

        assertEq(adapter.previewWithdrawCost(address(vault), 100e18), 100e18);
    }

    function test_PreviewWithdrawUpToEqualsAssetsWhenNoFee() public {
        asset.mint(address(this), 1_000e18);
        asset.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18, address(this));

        assertEq(
            adapter.previewWithdrawUpTo(address(vault), address(this), 100e18),
            100e18
        );
    }

    function test_PreviewWithdrawUpToCapsAtFullPosition() public {
        asset.mint(address(this), 1_000e18);
        asset.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18, address(this));

        // Asking for more position value than the holder owns caps at the full position.
        assertEq(
            adapter.previewWithdrawUpTo(
                address(vault),
                address(this),
                5_000e18
            ),
            1_000e18
        );
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
}
