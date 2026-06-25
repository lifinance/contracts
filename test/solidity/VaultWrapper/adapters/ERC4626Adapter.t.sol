// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { IYieldAdapter } from "lifi/VaultWrapper/interfaces/IYieldAdapter.sol";
import { MockERC4626Underlying } from "../mocks/MockERC4626Underlying.sol";

contract ERC4626AdapterTest is Test {
    ERC4626Adapter internal adapter;
    address internal assetToken = makeAddr("asset");

    function setUp() public {
        adapter = new ERC4626Adapter();
    }

    function test_ResolveAssetReturnsAssetForValidVault() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(assetToken);
        assertEq(adapter.resolveAsset(address(vault)), assetToken);
    }

    function test_ResolveAssetRevertsOnNoCode() public {
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(makeAddr("eoa"));
    }

    function test_ResolveAssetRevertsOnZeroAsset() public {
        MockERC4626Underlying vault = new MockERC4626Underlying(address(0));
        vm.expectRevert(IYieldAdapter.AssetResolutionFailed.selector);
        adapter.resolveAsset(address(vault));
    }
}
