// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { MockLiquidityCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockLiquidityCappedERC4626.sol";

/// @notice Handler that drives a single `LiFiVaultWrapper` through bounded, randomized
///         multi-actor sequences for the invariant suite: three depositors enter/exit while
///         the underlying's price per share is moved by injected yield/loss and time warps,
///         the vaultAdmin retunes fee rates and toggles pause, and anyone distributes fees. Every input
///         is bounded so no operation reverts for a legitimate reason (the suite runs
///         `fail-on-revert = true`, so any revert is a real defect), with one documented
///         exception: `withdraw`'s exact-out cost-aware pricing round-trips through the
///         source's own preview/convert functions, whose rounding noise scales with the
///         source's price per share and can occasionally exceed an actor's tight headroom
///         right at their own `maxWithdraw` (see `withdraw` below) — that single, understood
///         revert path is caught and re-verified as exactly that boundary (asserting the
///         burn would have exceeded the owner's balance) rather than failing the campaign;
///         any other revert still fails it. Deposits are the only
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
    /// @notice Assets ever paid out to exiters across all exits.
    uint256 public cumulativePaidOut;
    /// @notice Value the exiters' burned shares were worth at exit (pre-exit, accrual-aware
    ///         convertToAssets). The new invariant asserts paid-out never exceeds this — an
    ///         exit can lose value to a source fee/loss but never GAIN at the stayers' expense.
    uint256 public cumulativeSliceValue;

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
        // fee-deducting previewRedeem) — drive the full allowed range so near-max/full
        // exits are exercised. Cost-aware previewWithdraw prices the burn through the
        // adapter's previewWithdrawCost, which round-trips through the source's own
        // preview/convert functions; that round-trip's rounding noise is bounded by
        // roughly "one source-share's worth of assets", which scales with the source's
        // price per share and can exceed the few wei of headroom left right at an
        // actor's own maxWithdraw (exercised here via the fuzzed high-yield injections).
        // The ONLY accepted revert is that exact-out burn-exceeds-balance boundary;
        // `redeem` has no such boundary and is exercised separately below, so exiting is
        // never blocked. Any other revert is a real defect and must fail the campaign.
        uint256 ceiling = WRAPPER.maxWithdraw(actor);
        if (ceiling == 0) return;

        uint256 assets = bound(_assets, 1, ceiling);
        // Value the shares the exit will burn, at the pre-exit (accrual-aware) price.
        uint256 sliceValue = WRAPPER.convertToAssets(
            WRAPPER.previewWithdraw(assets)
        );

        vm.prank(actor);
        try WRAPPER.withdraw(assets, actor, actor) returns (uint256) {
            ghostAssetsOut += assets;
            cumulativePaidOut += assets;
            cumulativeSliceValue += sliceValue;
            _ratchetHwm();
        } catch {
            // The ONLY accepted revert is the exact-out boundary (finding #4, out of
            // scope): cost-aware previewWithdraw rounds the share burn above the owner's
            // balance at/near their own maxWithdraw. Any revert while the burn is
            // affordable is a real defect and must fail the campaign.
            assertGt(
                WRAPPER.previewWithdraw(assets),
                WRAPPER.balanceOf(actor),
                "withdraw reverted below the exact-out share-rounding boundary"
            );
        }
    }

    function redeem(uint256 _actorSeed, uint256 _shares) external {
        address actor = _actor(_actorSeed);
        uint256 ceiling = WRAPPER.maxRedeem(actor);
        if (ceiling == 0) return;

        uint256 shares = bound(_shares, 1, ceiling);
        uint256 sliceValue = WRAPPER.convertToAssets(shares);

        vm.prank(actor);
        uint256 received = WRAPPER.redeem(shares, actor, actor);

        ghostAssetsOut += received;
        cumulativePaidOut += received;
        cumulativeSliceValue += sliceValue;
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

/// @notice Handler variant that additionally fuzzes the source's withdrawal-liquidity cap,
///         driving `maxRedeem`/`maxWithdraw` through their full liquidity-clamped range.
contract VaultWrapperCappedSourceInvariantHandler is
    VaultWrapperInvariantHandler
{
    constructor(
        LiFiVaultWrapper _wrapper,
        MockERC20 _asset,
        MockERC4626 _underlying,
        LiFiVaultWrapperFactory _factory,
        address _vaultAdmin
    )
        VaultWrapperInvariantHandler(
            _wrapper,
            _asset,
            _underlying,
            _factory,
            _vaultAdmin
        )
    {}

    /// @notice Moves the source's withdrawable-liquidity cap anywhere in [0, totalAssets].
    function setLiquidity(uint256 _assets) external {
        uint256 total = UNDERLYING.totalAssets();
        MockLiquidityCappedERC4626(address(UNDERLYING)).setWithdrawable(
            bound(_assets, 0, total)
        );
    }
}
