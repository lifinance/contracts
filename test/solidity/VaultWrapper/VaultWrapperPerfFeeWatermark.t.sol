// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";

/// @notice Regression tests for two performance-fee watermark defects: (1) a pre-seed
///         donation to the empty wrapper being booked as gain against the first depositor,
///         and (2) the floored post-dilution watermark re-charging a full price step on
///         low-decimal assets. Both are exercised through the public entrypoints so a
///         reintroduction of either bug fails here.
contract PerfFeeDonationWatermarkTest is VaultWrapperFeeTestBase {
    uint16 internal constant PERF_RATE = 2000; // 20% of gains

    function _newWrapperPerfOnly(
        uint16 _rate
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [_rate, 0, 0, 0];

        return
            _newWrapperWithSplits(
                FeeConfig({ rateBps: rates }),
                [SPLIT, SPLIT, SPLIT, SPLIT]
            );
    }

    /// @dev Principal-free accrual trigger that keeps the fee counters intact:
    ///      `distributeFees` pays them out, and a dust deposit trips solmate's
    ///      ZERO_SHARES forward guard once the source pps exceeds 1. Re-setting the
    ///      already-zero management rate accrues first and changes nothing.
    function _accrueOnly() internal {
        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 0);
    }

    /// @dev Credits the empty wrapper with a source-vault position without minting any
    ///      wrapper shares — the "donation to the predicted address" of the first defect.
    function _donateToWrapperPosition(uint256 _assets) internal {
        asset.mint(address(this), _assets);
        asset.approve(address(underlying), _assets);
        underlying.deposit(_assets, address(wrapper));
    }

    function _parPps() internal view returns (uint256) {
        return
            LibVaultWrapperMath.pricePerShare(
                0,
                0,
                wrapper.shareDecimalsOffset()
            );
    }

    function test_DonationToEmptyWrapperNotChargedToFirstDepositor() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        _donateToWrapperPosition(1e15);
        assertEq(wrapper.totalSupply(), 0);
        assertGt(wrapper.totalAssets(), 0);

        _deposit(alice, DEPOSIT);

        // The first deposit re-anchors the watermark to its (donation-inflated) entry price
        // instead of leaving it at the empty-vault par anchor.
        assertGt(wrapper.perfHighWaterMarkPps(), _parPps());

        // A later deposit runs an accrual at non-zero supply; it must not book the donation
        // as a gain against the shares already held.
        _deposit(bob, DEPOSIT);

        assertEq(_accruedFeeShares(), 0);

        // Alice keeps essentially her full principal (only sub-wei virtual-offset rounding
        // dust) — never the ~20% haircut the pre-fix watermark produced.
        uint256 aliceAssets = wrapper.convertToAssets(
            wrapper.balanceOf(alice)
        );
        assertGe(aliceAssets, (DEPOSIT * 9999) / 10_000);
    }

    function test_DustSupplyDonationNotChargedToNextDepositor() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        // Bob seeds then exits down to a supply so small the perf dilution floors to
        // zero shares (dilutionShares ~ rate * supply, zero below 1/rate shares), so
        // no fee mint can ratchet the watermark over the donation.
        _deposit(bob, DEPOSIT);
        uint256 bobShares = wrapper.balanceOf(bob);
        vm.prank(bob);
        wrapper.redeem(bobShares - 1, bob, bob);

        assertGt(wrapper.totalSupply(), 0);
        assertLt(wrapper.totalSupply(), 10_000 / PERF_RATE);

        _donateToWrapperPosition(1e15);

        _deposit(alice, DEPOSIT);

        // A later accrual at full supply must not book the donation as a gain against Alice.
        _deposit(makeAddr("carol"), DEPOSIT);

        assertEq(_accruedFeeShares(), 0);

        uint256 aliceAssets = wrapper.convertToAssets(
            wrapper.balanceOf(alice)
        );
        assertGe(aliceAssets, (DEPOSIT * 9999) / 10_000);
    }

    function test_DustSupplyYieldEscapesPerfFee() public {
        // Accepted per-accrual leak: a gain whose perf dilution floors to zero shares
        // (dilutionShares ~ rate * supply, zero below 1/rate shares) is forgiven — the
        // accrual ratchets the watermark over it instead of minting.
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        _deposit(bob, DEPOSIT);
        uint256 bobShares = wrapper.balanceOf(bob);
        vm.prank(bob);
        wrapper.redeem(bobShares - 1, bob, bob);

        assertGt(wrapper.totalSupply(), 0);
        assertLt(wrapper.totalSupply(), 10_000 / PERF_RATE);

        // Genuine source-side yield at dust supply.
        _simulateYield(1e18);

        assertGe(wrapper.totalAssets(), 1e18);

        // The entry accrual ratchets the watermark over the gain; no fee shares minted.
        _deposit(alice, DEPOSIT);

        assertEq(_accruedFeeShares(), 0);
        assertGt(wrapper.perfHighWaterMarkPps(), _parPps());
    }

    function testFuzz_WatermarkNeverStaleAfterAccrual(
        uint96 _gainRaw,
        uint96 _depositRaw
    ) public {
        // After any perf-enabled accrual the mark must sit at/above the live measured
        // price or fee shares were minted for the full gap — a stale mark lets pre-entry
        // gains be charged to a later depositor as fabricated gain.
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        uint256 dep = bound(uint256(_depositRaw), 1, 1_000e18);
        uint256 gain = bound(uint256(_gainRaw), 1, 1_000e18);

        _deposit(bob, dep);
        _simulateYield(gain);
        _accrueOnly();

        uint256 livePps = LibVaultWrapperMath.pricePerShare(
            wrapper.totalSupply(),
            wrapper.totalAssets(),
            wrapper.shareDecimalsOffset()
        );

        assertGe(wrapper.perfHighWaterMarkPps(), livePps);

        // The same property from the fee side: nothing is left chargeable.
        uint256 feesAfterAccrual = _accruedFeeShares();
        _accrueOnly();
        assertEq(_accruedFeeShares(), feesAfterAccrual);
    }

    function test_LossRecoveryNotChargedAgain() public {
        // Up-only requirement: an accrual after a loss must not float the mark down,
        // or recovering back to the old peak would be re-charged as new gain.
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        _deposit(bob, DEPOSIT);
        _simulateYield(100e18);
        _accrueOnly();

        uint256 feesAtPeak = _accruedFeeShares();
        assertGt(feesAtPeak, 0);

        _simulateLoss(100e18);
        _accrueOnly();

        _simulateYield(100e18);
        _accrueOnly();

        assertEq(_accruedFeeShares(), feesAtPeak);
    }

    function test_FrequentAccrualsCollectTheSameFeeAsOneAccrual() public {
        // Ten sub-gain accruals vs one lump accrual of the same total gain: per-accrual
        // rounding is flooring slack only, so the fee cannot be moved by accrual
        // frequency in either direction.
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(bob, DEPOSIT);

        uint256 totalGain = 1e18;
        for (uint256 i = 0; i < 10; i++) {
            _simulateYield(totalGain / 10);
            _accrueOnly();
        }
        uint256 feeSplit = _accruedFeeShares();

        // Fresh source too: yield minted to a shared source is split pro-rata with the
        // first wrapper's position, which would halve the lump-path gain.
        underlying = new MockERC4626(asset, "Yield Token", "yTOK");
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(bob, DEPOSIT);
        _simulateYield(totalGain);
        _accrueOnly();
        uint256 feeSingle = _accruedFeeShares();

        // The split path may slightly EXCEED the lump in share terms (~0.04% measured):
        // earlier fee mints participate in later chunks' gains. Bounded both ways —
        // no dodging low side, no runaway compounding high side.
        assertApproxEqRel(feeSplit, feeSingle, 0.001e18); // 0.1%
    }

    function test_PreviewDepositMatchesExecutionAtDustSupply() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        // Dust supply (below the shares a 1-wei deposit mints) with pps pushed above
        // the watermark — the regime that used to take a special accrual path. Preview
        // and execution must agree on the perf dilution here like everywhere else
        // (EIP-4626: previewDeposit must not overstate what the deposit mints). Enough
        // real shares are left that the pending perf dilution itself is non-zero.
        _deposit(bob, DEPOSIT);
        uint256 dustScale = 10 ** wrapper.shareDecimalsOffset();
        uint256 toRedeem = wrapper.balanceOf(bob) - dustScale / 2;
        vm.prank(bob);
        wrapper.redeem(toRedeem, bob, bob);

        assertLt(wrapper.totalSupply(), dustScale);

        _donateToWrapperPosition(1e15);

        uint256 quote = wrapper.previewDeposit(DEPOSIT);
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 shares = wrapper.deposit(DEPOSIT, alice);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(shares, quote);
    }

    function test_PricePerShareFloorsTheDivision() public pure {
        // 7 * PPS_SCALE / 3 is not exact: the remainder is dropped, never rounded up, so
        // the watermark anchor and the gain measurement share one price.
        assertEq(
            LibVaultWrapperMath.pricePerShare(2, 6, 0),
            (7 * LibVaultWrapperMath.PPS_SCALE) / 3
        );
    }
}

/// @notice The price-per-share grid on a 6-decimal asset, where one unit of the grid used
///         to be a whole token of a 1M vault. Both watermark defects this file guards lived
///         here: anchoring below the measured price re-charged a full unit each crossing
///         (~76% of the yield confiscated), and anchoring above it forgave a unit per
///         crossing, which suppressed the fee entirely once accruals came more often than
///         one unit of yield. Deployed through the real factory stack so `distributeFees`
///         (a principal-free, permissionless accrual trigger) is available.
contract PerfFeeLowDecimalGridTest is VaultWrapperFeeTestBase {
    uint16 internal constant PERF_RATE = 2000; // 20% of gains
    uint256 internal constant PRINCIPAL = 1_000_000e6;
    uint256 internal constant TOTAL_YIELD = 84e6;
    /// @dev The fee is quantized to the price grid and each round's charge rounds up, so
    ///      the collected total sits within a hair of the rate rather than exactly on it.
    uint256 internal constant FEE_TOLERANCE = 0.001e18; // 0.1%

    function setUp() public override {
        asset = new MockERC20("USD Coin", "USDC", 6);
        underlying = new MockERC4626(asset, "Yield USDC", "yUSDC");
        adapter = new ERC4626Adapter();
        _stackWithFactory(FeeType.Performance, PERF_RATE, 5000);
    }

    /// @dev Fee collected on `alice`'s position: what the holder does not get back.
    function _feeCollected() internal returns (uint256) {
        uint256 aliceShares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 aliceOut = wrapper.redeem(aliceShares, alice, alice);

        return PRINCIPAL + TOTAL_YIELD - aliceOut;
    }

    function _expectedFee() internal pure returns (uint256) {
        return (TOTAL_YIELD * PERF_RATE) / 10_000;
    }

    function test_PerfFeeMatchesRateInOneAccrual() public {
        _deposit(alice, PRINCIPAL);
        _simulateYield(TOTAL_YIELD);
        wrapper.distributeFees();

        assertApproxEqRel(_feeCollected(), _expectedFee(), FEE_TOLERANCE);
    }

    /// @dev The same yield sliced into rounds each smaller than one unit of the price grid,
    ///      with an accrual after every one. Accrual frequency is caller-controlled through
    ///      the permissionless `distributeFees`, so the fee must not depend on it: two-sided
    ///      bounds, since a leak in either direction is exploitable by whoever benefits.
    function test_PerfFeeMatchesRateAcrossManyAccruals() public {
        _deposit(alice, PRINCIPAL);

        uint256 rounds = 400;
        uint256 drip = TOTAL_YIELD / rounds; // 0.21 USDC per round
        for (uint256 i = 0; i < rounds; i++) {
            _simulateYield(drip);
            wrapper.distributeFees();
        }

        assertApproxEqRel(_feeCollected(), _expectedFee(), FEE_TOLERANCE);
    }
}
