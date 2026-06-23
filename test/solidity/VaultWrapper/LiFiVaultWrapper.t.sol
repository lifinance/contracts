// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { AlreadyInitialized } from "lifi/Errors/GenericErrors.sol";

/// @notice ERC-4626 underlying that can be armed to revert or re-enter the wrapper on
///         deposit, used to test delegatecall revert bubbling and the reentrancy guard.
contract HostileUnderlying is MockERC4626 {
    enum Mode {
        None,
        Revert,
        Reenter
    }

    error Boom();

    Mode public mode;
    LiFiVaultWrapper public wrapper;

    constructor(ERC20 _asset) MockERC4626(_asset, "Hostile", "HOST") {}

    function arm(Mode _mode, LiFiVaultWrapper _wrapper) external {
        mode = _mode;
        wrapper = _wrapper;
    }

    function deposit(
        uint256 _assets,
        address _to
    ) public override returns (uint256) {
        if (mode == Mode.Revert) revert Boom();
        if (mode == Mode.Reenter)
            wrapper.withdraw(1, address(this), address(this));

        return super.deposit(_assets, _to);
    }
}

contract LiFiVaultWrapperTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    LiFiVaultWrapper internal wrapper;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");

    uint256 internal constant DEPOSIT = 1_000e18;

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        wrapper = _newWrapper(address(underlying));
    }

    /// Initialization ///

    function test_InitializeSetsState() public view {
        assertTrue(wrapper.initialized());
        assertEq(wrapper.asset(), address(asset));
        assertEq(wrapper.underlying(), address(underlying));
        assertEq(wrapper.adapter(), address(adapter));
        assertEq(wrapper.vaultWrapperAdmin(), vaultAdmin);
        assertEq(wrapper.factory(), address(this));
        assertEq(wrapper.integratorShareBps(), 8000);
        assertEq(wrapper.decimals(), 18);
        assertEq(wrapper.name(), "LI.FI Earn Vault Wrapper");
        assertEq(wrapper.symbol(), "lfVW");
    }

    function testRevert_InitializeTwice() public {
        FeeConfig memory fees;

        vm.expectRevert(AlreadyInitialized.selector);

        wrapper.initialize(
            address(asset),
            address(underlying),
            address(adapter),
            vaultAdmin,
            8000,
            fees,
            ""
        );
    }

    /// Deposit / pass-through ///

    function test_DepositForwardsAssetsToUnderlying() public {
        _deposit(alice, DEPOSIT);

        assertEq(asset.balanceOf(address(wrapper)), 0);
        assertEq(asset.balanceOf(address(underlying)), DEPOSIT);
        assertEq(underlying.balanceOf(address(wrapper)), DEPOSIT);
        assertEq(wrapper.totalAssets(), DEPOSIT);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
        assertEq(wrapper.totalSupply(), DEPOSIT);
    }

    function test_MintForwardsAssetsToUnderlying() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 assetsIn = wrapper.mint(DEPOSIT, alice);
        vm.stopPrank();

        assertEq(assetsIn, DEPOSIT);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
        assertEq(wrapper.totalAssets(), DEPOSIT);
        assertEq(asset.balanceOf(address(wrapper)), 0);
    }

    /// Round-trips ///

    function test_RedeemRoundTrip() public {
        _deposit(alice, DEPOSIT);

        uint256 shares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice);

        assertApproxEqAbs(assetsOut, DEPOSIT, 1);
        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
        assertEq(wrapper.balanceOf(alice), 0);
    }

    function test_WithdrawRoundTrip() public {
        _deposit(alice, DEPOSIT);

        vm.prank(alice);
        uint256 sharesBurned = wrapper.withdraw(DEPOSIT, alice, alice);

        assertApproxEqAbs(sharesBurned, DEPOSIT, 1);
        assertApproxEqAbs(asset.balanceOf(alice), DEPOSIT, 1);
        assertApproxEqAbs(wrapper.balanceOf(alice), 0, 1);
    }

    /// Accounting ///

    function test_PreviewMatchesActualDepositAndRedeem() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        uint256 previewedShares = wrapper.previewDeposit(DEPOSIT);
        uint256 mintedShares = wrapper.deposit(DEPOSIT, alice);
        assertEq(mintedShares, previewedShares);

        uint256 previewedAssets = wrapper.previewRedeem(mintedShares);
        uint256 redeemedAssets = wrapper.redeem(mintedShares, alice, alice);
        vm.stopPrank();

        assertEq(redeemedAssets, previewedAssets);
    }

    function test_YieldAccrualIncreasesRedeemValue() public {
        _deposit(alice, DEPOSIT);

        // Simulate yield: assets appear in the underlying without new shares minted.
        uint256 yield = 100e18;
        asset.mint(address(underlying), yield);

        assertEq(wrapper.totalAssets(), DEPOSIT + yield);

        uint256 shares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice);

        assertApproxEqAbs(assetsOut, DEPOSIT + yield, 1);
    }

    function test_TwoDepositorsShareProportionally() public {
        _deposit(alice, DEPOSIT);
        _deposit(bob, DEPOSIT);

        assertApproxEqAbs(wrapper.balanceOf(alice), wrapper.balanceOf(bob), 1);
        assertEq(wrapper.totalAssets(), DEPOSIT * 2);

        uint256 bobShares = wrapper.balanceOf(bob);
        vm.prank(bob);
        uint256 bobAssets = wrapper.redeem(bobShares, bob, bob);

        assertApproxEqAbs(bobAssets, DEPOSIT, 1);
        assertApproxEqAbs(wrapper.totalAssets(), DEPOSIT, 1);
    }

    function test_VirtualSharesGiveSecondDepositorFairShares() public {
        // A 1-wei first deposit must not let virtual-share accounting zero out a
        // normal-sized second deposit (the empty-vault edge the inflation attack targets).
        _deposit(alice, 1);
        _deposit(bob, DEPOSIT);

        uint256 bobShares = wrapper.balanceOf(bob);
        assertGt(bobShares, 0);

        vm.prank(bob);
        uint256 bobAssets = wrapper.redeem(bobShares, bob, bob);

        assertApproxEqAbs(bobAssets, DEPOSIT, 2);
    }

    /// Adapter delegatecall safety ///

    function testRevert_AdapterRevertBubblesUp() public {
        HostileUnderlying hostile = new HostileUnderlying(asset);
        LiFiVaultWrapper w = _newWrapper(address(hostile));
        hostile.arm(HostileUnderlying.Mode.Revert, w);

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(HostileUnderlying.Boom.selector);

        w.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function testRevert_ReentrantCallBlocked() public {
        HostileUnderlying hostile = new HostileUnderlying(asset);
        LiFiVaultWrapper w = _newWrapper(address(hostile));
        hostile.arm(HostileUnderlying.Mode.Reenter, w);

        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(w), DEPOSIT);

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);

        w.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    /// Helpers ///

    function _newWrapper(
        address _underlying
    ) internal returns (LiFiVaultWrapper w) {
        w = new LiFiVaultWrapper();
        FeeConfig memory fees;
        w.initialize(
            address(asset),
            _underlying,
            address(adapter),
            vaultAdmin,
            8000,
            fees,
            ""
        );
    }

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }
}
