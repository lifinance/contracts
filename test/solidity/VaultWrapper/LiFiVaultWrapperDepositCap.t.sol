// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { FeeConfig, DeployParams, FeeReceiver } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFactoryStackBase } from "test/solidity/VaultWrapper/VaultWrapperFactoryStackBase.sol";
import { MockDepositCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockDepositCappedERC4626.sol";

/// @notice Entry-side mirror of LiFiVaultWrapperLiquidityTest: proves `maxDeposit`/`maxMint`
///         fold the yield source's inflow cap so a caller that respects the reported max
///         never reverts, and that a deposit past it reverts with the EIP-4626 limit error
///         rather than deep inside the source.
contract LiFiVaultWrapperDepositCapTest is VaultWrapperFactoryStackBase {
    MockERC20 internal asset;
    MockDepositCappedERC4626 internal source;

    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal integrator = makeAddr("integrator");
    address internal alice = makeAddr("alice");

    uint256 internal constant SEED = 1_000e18;

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        source = new MockDepositCappedERC4626(asset, "Yield", "yTKN");

        _bringUpFactory(address(source), [uint16(5000), 1000, 2000, 2000]);
        _deployWrapper(_params());

        asset.mint(alice, 10_000e18);
        vm.startPrank(alice);
        asset.approve(address(wrapper), 10_000e18);
        wrapper.deposit(SEED, alice);

        vm.stopPrank();
    }

    function _params() private view returns (DeployParams memory) {
        FeeReceiver[] memory receivers = new FeeReceiver[](1);
        receivers[0] = FeeReceiver({ wallet: integrator, bps: 10000 });

        return
            DeployParams({
                namespace: bytes32("LI.FI-Earn"),
                vaultWrapperAdmin: vaultAdmin,
                adapter: address(adapter),
                underlying: address(source),
                nonce: 0,
                fees: FeeConfig({ rateBps: [uint16(0), 0, 0, 0] }),
                integratorShareBps: [uint16(8000), 8000, 8000, 8000],
                accessGate: address(0),
                receivers: receivers
            });
    }

    function test_MaxDepositUnlimitedWhenSourceUncapped() public view {
        assertEq(wrapper.maxDeposit(alice), type(uint256).max);
        assertEq(wrapper.maxMint(alice), type(uint256).max);
    }

    function test_MaxDepositReflectsSourceHeadroom() public {
        source.setDepositCap(SEED + 500e18);

        assertEq(wrapper.maxDeposit(alice), 500e18);
    }

    function test_MaxMintReflectsSourceHeadroom() public {
        source.setDepositCap(SEED + 500e18);

        assertEq(wrapper.maxMint(alice), wrapper.previewDeposit(500e18));
    }

    function test_MaxDepositIsZeroWhenCapReached() public {
        source.setDepositCap(SEED);

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }

    function test_DepositAtCappedMaxSucceeds() public {
        source.setDepositCap(SEED + 500e18);
        uint256 maxAssets = wrapper.maxDeposit(alice);

        vm.prank(alice);
        uint256 shares = wrapper.deposit(maxAssets, alice);

        assertGt(shares, 0);
        assertEq(wrapper.maxDeposit(alice), 0);
    }

    function testRevert_DepositAboveCappedMax() public {
        source.setDepositCap(SEED + 500e18);
        uint256 maxAssets = wrapper.maxDeposit(alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxDeposit.selector,
                alice,
                maxAssets + 1,
                maxAssets
            )
        );

        vm.prank(alice);
        wrapper.deposit(maxAssets + 1, alice);
    }

    function test_MintAtCappedMaxSucceeds() public {
        source.setDepositCap(SEED + 500e18);
        uint256 maxShares = wrapper.maxMint(alice);

        vm.prank(alice);
        uint256 assets = wrapper.mint(maxShares, alice);

        assertGt(assets, 0);
    }

    function testRevert_MintAboveCappedMax() public {
        source.setDepositCap(SEED + 500e18);
        uint256 maxShares = wrapper.maxMint(alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxMint.selector,
                alice,
                maxShares + 1,
                maxShares
            )
        );

        vm.prank(alice);
        wrapper.mint(maxShares + 1, alice);
    }

    // The partial-headroom case from the finding: with the cap partway above the seeded
    // position, an integrator can size a deposit off the reported max, fill it exactly, and
    // sees the max drop to zero rather than guessing into a source revert.
    function test_PartialHeadroomIsSizableThenClosed() public {
        source.setDepositCap(SEED + 100e18);
        assertEq(wrapper.maxDeposit(alice), 100e18);

        vm.prank(alice);
        wrapper.deposit(100e18, alice);

        assertEq(wrapper.maxDeposit(alice), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxDeposit.selector,
                alice,
                1,
                0
            )
        );

        vm.prank(alice);
        wrapper.deposit(1, alice);
    }

    function test_MaxDepositAndMaxMintZeroWhenPausedDespiteHeadroom() public {
        source.setDepositCap(SEED + 500e18);

        vm.prank(vaultAdmin);
        wrapper.pause();

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }
}
