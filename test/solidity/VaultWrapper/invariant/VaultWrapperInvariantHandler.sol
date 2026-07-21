// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Handler that drives a single `LiFiVaultWrapper` through bounded, randomized
///         multi-actor sequences for the invariant suite: three depositors enter/exit while
///         the underlying's price per share is moved by injected yield/loss and time warps,
///         the vaultAdmin retunes fee rates and toggles pause, and anyone distributes fees. Every input
///         is bounded so no operation reverts for a legitimate reason (the suite runs
///         `fail-on-revert = true`, so any revert is a real defect); deposits are the only
///         path gated by pause, so they are skipped while paused while exits are left
///         unguarded — a pause that ever blocked an exit would surface as a revert. Ghost
///         totals (assets in vs out, yield injected) and a high-water-mark ratchet are
///         maintained here for the test contract's invariants to read.
contract VaultWrapperInvariantHandler is Test {
    uint256 internal constant NUM_ACTORS = 3;

    // Deposits/mints are floored well above any price-per-share the bounded yield can push
    // the underlying to, so an underlying `deposit` never rounds to zero shares.
    uint256 internal constant MIN_ENTER = 1e18;
    uint256 internal constant MAX_ENTER = 1e24;
    uint256 internal constant MAX_YIELD = 1e22;
    uint256 internal constant MAX_WARP = 30 days;

    LiFiVaultWrapper internal immutable WRAPPER;
    MockERC20 internal immutable ASSET;
    MockERC4626 internal immutable UNDERLYING;
    LiFiVaultWrapperFactory internal immutable FACTORY;
    address internal immutable VAULT_ADMIN;

    address[NUM_ACTORS] public actors;

    /// @notice Gross assets ever paid into the wrapper by depositors (entry amount incl. fee).
    uint256 public ghostAssetsIn;
    /// @notice Assets ever received by depositors on exit (net of the withdrawal fee).
    uint256 public ghostAssetsOut;
    /// @notice Assets ever injected into the underlying as external yield.
    uint256 public ghostYield;
    /// @notice Highest high-water mark observed; the ratchet asserts it never regresses.
    uint256 public hwmFloor;

    constructor(
        LiFiVaultWrapper _wrapper,
        MockERC20 _asset,
        MockERC4626 _underlying,
        LiFiVaultWrapperFactory _factory,
        address _vaultAdmin
    ) {
        WRAPPER = _wrapper;
        ASSET = _asset;
        UNDERLYING = _underlying;
        FACTORY = _factory;
        VAULT_ADMIN = _vaultAdmin;

        for (uint256 i; i < NUM_ACTORS; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
        hwmFloor = _wrapper.perfHighWaterMarkPps();
    }

    function deposit(uint256 _actorSeed, uint256 _assets) external {
        if (WRAPPER.depositsPaused()) return;

        address actor = _actor(_actorSeed);
        uint256 assets = bound(_assets, MIN_ENTER, MAX_ENTER);
        ASSET.mint(actor, assets);

        vm.startPrank(actor);
        ASSET.approve(address(WRAPPER), assets);
        WRAPPER.deposit(assets, actor);

        vm.stopPrank();

        ghostAssetsIn += assets;
        _ratchetHwm();
    }

    function mint(uint256 _actorSeed, uint256 _shares) external {
        if (WRAPPER.depositsPaused()) return;

        address actor = _actor(_actorSeed);
        uint256 shares = bound(_shares, MIN_ENTER, MAX_ENTER);
        uint256 assets = WRAPPER.previewMint(shares);
        ASSET.mint(actor, assets);

        vm.startPrank(actor);
        ASSET.approve(address(WRAPPER), assets);
        WRAPPER.mint(shares, actor);

        vm.stopPrank();

        ghostAssetsIn += assets;
        _ratchetHwm();
    }

    function withdraw(uint256 _actorSeed, uint256 _assets) external {
        address actor = _actor(_actorSeed);
        // maxWithdraw is fee-aware (previewRedeem(maxRedeem(owner)) with the wrapper's
        // fee-deducting previewRedeem), so withdraw(maxWithdraw(actor)) is exactly
        // exitable — drive the full allowed range so near-max/full exits are exercised.
        uint256 ceiling = WRAPPER.maxWithdraw(actor);
        if (ceiling == 0) return;

        uint256 assets = bound(_assets, 1, ceiling);

        vm.prank(actor);
        WRAPPER.withdraw(assets, actor, actor);

        ghostAssetsOut += assets;
        _ratchetHwm();
    }

    function redeem(uint256 _actorSeed, uint256 _shares) external {
        address actor = _actor(_actorSeed);
        uint256 balance = WRAPPER.balanceOf(actor);
        if (balance == 0) return;

        uint256 shares = bound(_shares, 1, balance);

        vm.prank(actor);
        uint256 received = WRAPPER.redeem(shares, actor, actor);

        ghostAssetsOut += received;
        _ratchetHwm();
    }

    function distributeFees() external {
        WRAPPER.distributeFees();

        _ratchetHwm();
    }

    function injectYield(uint256 _amount) external {
        uint256 amount = bound(_amount, 0, MAX_YIELD);
        ASSET.mint(address(UNDERLYING), amount);

        ghostYield += amount;
    }

    function injectLoss(uint256 _amount) external {
        uint256 held = ASSET.balanceOf(address(UNDERLYING));
        if (held == 0) return;

        uint256 amount = bound(_amount, 0, held / 2);
        deal(address(ASSET), address(UNDERLYING), held - amount);
    }

    function warp(uint256 _seconds) external {
        vm.warp(block.timestamp + bound(_seconds, 0, MAX_WARP));
    }

    function setFee(uint256 _typeSeed, uint256 _rateSeed) external {
        FeeType feeType = FeeType(bound(_typeSeed, 0, 3));
        (, uint16 maxBps) = FACTORY.feeBounds(feeType);
        uint16 rate = uint16(bound(_rateSeed, 0, maxBps));

        vm.prank(VAULT_ADMIN);
        WRAPPER.setFeeRate(feeType, rate);

        _ratchetHwm();
    }

    function togglePause() external {
        bool isPaused = WRAPPER.paused();

        vm.prank(VAULT_ADMIN);
        if (isPaused) {
            WRAPPER.unpause();
        } else {
            WRAPPER.pause();
        }
    }

    function _actor(uint256 _seed) private view returns (address) {
        return actors[bound(_seed, 0, NUM_ACTORS - 1)];
    }

    /// @dev Asserts the performance high-water mark never regresses across any operation that
    ///      crystallizes fees, then advances the floor. The mark is re-anchored up-only on a
    ///      fee re-enable and ratcheted up on a performance accrual, so it must be monotonic.
    function _ratchetHwm() private {
        uint256 current = WRAPPER.perfHighWaterMarkPps();
        assertGe(current, hwmFloor, "high-water mark regressed");
        hwmFloor = current;
    }
}
