// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";

/// @notice Thin external harness exposing the internal pure library so tests can
///         exercise it across the ABI boundary (and fuzz it directly).
contract LibMathHarness {
    function feeOnRaw(
        uint256 _assets,
        uint16 _feeBps
    ) external pure returns (uint256) {
        return LibVaultWrapperMath.feeOnRaw(_assets, _feeBps);
    }

    function feeOnTotal(
        uint256 _assets,
        uint16 _feeBps
    ) external pure returns (uint256) {
        return LibVaultWrapperMath.feeOnTotal(_assets, _feeBps);
    }

    function managementFeeAssets(
        uint256 _totalAssets,
        uint16 _rateBps,
        uint256 _elapsed
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.managementFeeAssets({
                _totalAssets: _totalAssets,
                _rateBps: _rateBps,
                _elapsed: _elapsed
            });
    }

    function dilutionShares(
        uint256 _feeAssets,
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: _feeAssets,
                _totalSupply: _totalSupply,
                _totalAssets: _totalAssets,
                _decimalsOffset: _decimalsOffset
            });
    }

    function pricePerShare(
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.pricePerShare({
                _totalSupply: _totalSupply,
                _totalAssets: _totalAssets,
                _decimalsOffset: _decimalsOffset
            });
    }

    function performanceFeeAssets(
        uint256 _totalAssets,
        uint256 _totalSupply,
        uint256 _hwmPps,
        uint16 _rateBps,
        uint8 _decimalsOffset
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.performanceFeeAssets({
                _totalAssets: _totalAssets,
                _totalSupply: _totalSupply,
                _hwmPps: _hwmPps,
                _rateBps: _rateBps,
                _decimalsOffset: _decimalsOffset
            });
    }

    function convertToShares(
        uint256 _assets,
        uint256 _totalSupply,
        uint256 _pendingFeeShares,
        uint256 _totalAssets,
        uint8 _decimalsOffset,
        Math.Rounding _rounding
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.convertToShares({
                _assets: _assets,
                _totalSupply: _totalSupply,
                _pendingFeeShares: _pendingFeeShares,
                _totalAssets: _totalAssets,
                _decimalsOffset: _decimalsOffset,
                _rounding: _rounding
            });
    }

    function convertToAssets(
        uint256 _shares,
        uint256 _totalSupply,
        uint256 _pendingFeeShares,
        uint256 _totalAssets,
        uint8 _decimalsOffset,
        Math.Rounding _rounding
    ) external pure returns (uint256) {
        return
            LibVaultWrapperMath.convertToAssets({
                _shares: _shares,
                _totalSupply: _totalSupply,
                _pendingFeeShares: _pendingFeeShares,
                _totalAssets: _totalAssets,
                _decimalsOffset: _decimalsOffset,
                _rounding: _rounding
            });
    }
}

/// @title LibVaultWrapperMathTest
/// @author LI.FI (https://li.fi)
/// @notice Unit and fuzz/property tests for the stateless vault-wrapper fee math.
contract LibVaultWrapperMathTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    LibMathHarness internal lib;

    function setUp() public {
        lib = new LibMathHarness();
    }

    /* ------------------------------- feeOnRaw -------------------------------- */

    function test_FeeOnRaw_KnownValues() public view {
        // 1% of 10000 = 100
        assertEq(lib.feeOnRaw(10_000, 100), 100);
        // 20% of 1000 = 200
        assertEq(lib.feeOnRaw(1000, 2000), 200);
        // 100% of an amount equals the amount
        assertEq(lib.feeOnRaw(777, 10_000), 777);
    }

    function test_FeeOnRaw_ZeroRateOrZeroAssets() public view {
        assertEq(lib.feeOnRaw(1_000_000, 0), 0);
        assertEq(lib.feeOnRaw(0, 2000), 0);
    }

    function test_FeeOnRaw_RoundsUp() public view {
        // 1 * 1bps / 10000 = 0.0001 -> ceil 1
        assertEq(lib.feeOnRaw(1, 1), 1);
        // 1 wei at 1% -> 0.01 -> ceil 1
        assertEq(lib.feeOnRaw(1, 100), 1);
        // 3 wei at 50% -> 1.5 -> ceil 2
        assertEq(lib.feeOnRaw(3, 5000), 2);
    }

    function testFuzz_FeeOnRaw_MatchesCeilFormula(
        uint256 _assets,
        uint16 _feeBps
    ) public view {
        _assets = bound(_assets, 0, type(uint128).max);

        uint256 expected = Math.mulDiv(
            _assets,
            _feeBps,
            BPS,
            Math.Rounding.Ceil
        );

        assertEq(lib.feeOnRaw(_assets, _feeBps), expected);
    }

    function testFuzz_FeeOnRaw_NeverExceedsAssets(
        uint256 _assets,
        uint16 _feeBps
    ) public view {
        _assets = bound(_assets, 0, type(uint128).max);
        _feeBps = uint16(bound(_feeBps, 0, BPS));

        assertLe(lib.feeOnRaw(_assets, _feeBps), _assets);
    }

    /* ------------------------------ feeOnTotal ------------------------------- */

    function test_FeeOnTotal_KnownValues() public view {
        // Gross that came from net 10000 at 1%: gross = 10100, fee = 100.
        // feeOnTotal(10100, 100) = 10100 * 100 / 10100 = 100
        assertEq(lib.feeOnTotal(10_100, 100), 100);
        // Gross 1200 from net 1000 at 20%: fee = 1200 * 2000 / 12000 = 200
        assertEq(lib.feeOnTotal(1200, 2000), 200);
    }

    function test_FeeOnTotal_ZeroRateOrZeroAssets() public view {
        assertEq(lib.feeOnTotal(1_000_000, 0), 0);
        assertEq(lib.feeOnTotal(0, 2000), 0);
    }

    function test_FeeOnTotal_RoundsUp() public view {
        // 1 * 2000 / 12000 = 0.166.. -> ceil 1
        assertEq(lib.feeOnTotal(1, 2000), 1);
    }

    function testFuzz_FeeOnTotal_MatchesCeilFormula(
        uint256 _assets,
        uint16 _feeBps
    ) public view {
        _assets = bound(_assets, 0, type(uint128).max);

        uint256 expected = Math.mulDiv(
            _assets,
            _feeBps,
            uint256(_feeBps) + BPS,
            Math.Rounding.Ceil
        );

        assertEq(lib.feeOnTotal(_assets, _feeBps), expected);
    }

    function testFuzz_FeeOnTotal_NeverExceedsAssets(
        uint256 _assets,
        uint16 _feeBps
    ) public view {
        _assets = bound(_assets, 0, type(uint128).max);

        assertLe(lib.feeOnTotal(_assets, _feeBps), _assets);
    }

    /* --------------------- Convention B round-trip identities ---------------- */

    // deposit<->mint and withdraw<->redeem both compose feeOnRaw/feeOnTotal the same
    // way, so one fuzz covers the identity: a `net` amount grossed up via feeOnRaw must
    // give back the same fee (and net) when decomposed via feeOnTotal. The wrapper-level
    // withdraw<->redeem inverse is asserted in LiFiVaultWrapperFees.t.sol.
    function testFuzz_DepositMintInverse(
        uint256 _net,
        uint16 _feeBps
    ) public view {
        _net = bound(_net, 0, type(uint128).max);

        uint256 fee = lib.feeOnRaw(_net, _feeBps);
        uint256 gross = _net + fee;
        uint256 feeBack = lib.feeOnTotal(gross, _feeBps);

        assertEq(feeBack, fee, "fee must round-trip");
        assertEq(gross - feeBack, _net, "net must round-trip");
    }

    /* -------------------------- managementFeeAssets -------------------------- */

    function test_ManagementFee_ZeroInputs() public view {
        assertEq(lib.managementFeeAssets(0, 1000, SECONDS_PER_YEAR), 0);
        assertEq(lib.managementFeeAssets(1e24, 0, SECONDS_PER_YEAR), 0);
        assertEq(lib.managementFeeAssets(1e24, 1000, 0), 0);
    }

    function test_ManagementFee_FullYearAtRate() public view {
        // 10% of 1_000_000 over exactly one year.
        uint256 totalAssets = 1_000_000;
        uint256 fee = lib.managementFeeAssets(
            totalAssets,
            1000,
            SECONDS_PER_YEAR
        );

        assertEq(fee, 100_000);
    }

    function test_ManagementFee_HalfYearIsHalf() public view {
        uint256 totalAssets = 1_000_000;
        uint256 full = lib.managementFeeAssets(
            totalAssets,
            1000,
            SECONDS_PER_YEAR
        );
        uint256 half = lib.managementFeeAssets(
            totalAssets,
            1000,
            SECONDS_PER_YEAR / 2
        );

        assertEq(half, full / 2);
    }

    // Doubling/x10 elapsed scales the fee proportionally; floor rounding can leave a
    // sub-wei remainder, so allow up to the multiplier in slack.
    function test_ManagementFee_LinearInElapsed() public view {
        uint256 totalAssets = 1e24;
        uint256 oneDay = lib.managementFeeAssets(totalAssets, 500, 1 days);
        uint256 twoDays = lib.managementFeeAssets(totalAssets, 500, 2 days);
        uint256 tenDays = lib.managementFeeAssets(totalAssets, 500, 10 days);

        assertGe(twoDays, oneDay * 2);
        assertLe(twoDays, oneDay * 2 + 1);
        assertGe(tenDays, oneDay * 10);
        assertLe(tenDays, oneDay * 10 + 10);
    }

    // Exact linearity holds when the division is clean (full year divides evenly).
    function test_ManagementFee_LinearInRate() public view {
        uint256 totalAssets = 1e24;
        uint256 atOnePct = lib.managementFeeAssets(
            totalAssets,
            100,
            SECONDS_PER_YEAR
        );
        uint256 atTwoPct = lib.managementFeeAssets(
            totalAssets,
            200,
            SECONDS_PER_YEAR
        );

        assertEq(atOnePct, 1e22);
        assertEq(atTwoPct, atOnePct * 2);
    }

    // When rate*elapsed implies a fee >= totalAssets, it clamps to totalAssets - 1.
    function test_ManagementFee_ClampsBelowTotalAssets() public view {
        uint256 totalAssets = 1_000_000;
        // 100% rate over many years would exceed totalAssets.
        uint256 fee = lib.managementFeeAssets(
            totalAssets,
            10_000,
            SECONDS_PER_YEAR * 5
        );

        assertEq(fee, totalAssets - 1);
    }

    function testFuzz_ManagementFee_NeverReachesTotalAssets(
        uint256 _totalAssets,
        uint16 _rateBps,
        uint256 _elapsed
    ) public view {
        _totalAssets = bound(_totalAssets, 1, type(uint128).max);
        _elapsed = bound(_elapsed, 0, SECONDS_PER_YEAR * 100);

        uint256 fee = lib.managementFeeAssets(
            _totalAssets,
            _rateBps,
            _elapsed
        );

        assertLt(fee, _totalAssets);
    }

    function testFuzz_ManagementFee_MatchesFloorFormula(
        uint256 _totalAssets,
        uint16 _rateBps,
        uint256 _elapsed
    ) public view {
        _totalAssets = bound(_totalAssets, 1, type(uint96).max);
        _elapsed = bound(_elapsed, 1, SECONDS_PER_YEAR);
        _rateBps = uint16(bound(_rateBps, 1, BPS));

        uint256 expected = Math.mulDiv(
            _totalAssets,
            uint256(_rateBps) * _elapsed,
            BPS * SECONDS_PER_YEAR,
            Math.Rounding.Floor
        );
        if (expected >= _totalAssets) expected = _totalAssets - 1;

        assertEq(
            lib.managementFeeAssets(_totalAssets, _rateBps, _elapsed),
            expected
        );
    }

    /* ----------------------------- dilutionShares ---------------------------- */

    function test_DilutionShares_ZeroFeeAssets() public view {
        assertEq(lib.dilutionShares(0, 1e18, 1e18, 0), 0);
    }

    function test_DilutionShares_DenominatorNonPositive() public view {
        // Guard returns 0 when _totalAssets + 1 <= _feeAssets.
        // feeAssets strictly above totalAssets -> 0
        assertEq(lib.dilutionShares(1001, 1e18, 999, 0), 0);
        // feeAssets == totalAssets + 1 (denom would be 0) -> 0
        assertEq(lib.dilutionShares(1001, 1e18, 1000, 0), 0);
        // feeAssets == totalAssets (denom == 1, NOT guarded) -> computes, non-zero
        assertGt(lib.dilutionShares(1000, 1e18, 1000, 0), 0);
    }

    function test_DilutionShares_SupplyZero() public view {
        // No existing shares: numerator is just the offset term.
        // feeShares = feeAssets * 10**offset / (totalAssets + 1 - feeAssets)
        uint256 shares = lib.dilutionShares(100, 0, 1_000_000, 0);

        assertEq(shares, Math.mulDiv(100, 1, 1_000_001 - 100));
    }

    function test_DilutionShares_KnownValue() public view {
        // supply 1e18, assets 1e18, offset 0, feeAssets 1e16 (1%).
        uint256 feeAssets = 1e16;
        uint256 supply = 1e18;
        uint256 assets = 1e18;
        uint256 shares = lib.dilutionShares(feeAssets, supply, assets, 0);
        uint256 expected = Math.mulDiv(
            feeAssets,
            supply + 1,
            assets + 1 - feeAssets
        );

        assertEq(shares, expected);
    }

    // Property: shares minted for feeAssets, valued back through the POST-mint pool
    // (OZ offset convention), recover at most feeAssets (floor never over-mints).
    function testFuzz_DilutionShares_WorthApproxFeeAssets(
        uint256 _feeAssets,
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) public view {
        _decimalsOffset = uint8(bound(_decimalsOffset, 0, 12));
        _totalAssets = bound(_totalAssets, 2, type(uint96).max);
        _feeAssets = bound(_feeAssets, 1, _totalAssets - 1);
        _totalSupply = bound(_totalSupply, 0, type(uint96).max);

        uint256 offset = 10 ** uint256(_decimalsOffset);
        uint256 feeShares = lib.dilutionShares(
            _feeAssets,
            _totalSupply,
            _totalAssets,
            _decimalsOffset
        );

        // assetsOut = feeShares * (totalAssets + 1) / (totalSupply + feeShares + offset)
        uint256 valued = Math.mulDiv(
            feeShares,
            _totalAssets + 1,
            _totalSupply + feeShares + offset
        );

        assertLe(valued, _feeAssets, "dilution must not over-mint");
    }

    function testFuzz_DilutionShares_NoRevert(
        uint256 _feeAssets,
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) public view {
        _decimalsOffset = uint8(bound(_decimalsOffset, 0, 18));
        _feeAssets = bound(_feeAssets, 0, type(uint128).max);
        _totalSupply = bound(_totalSupply, 0, type(uint128).max);
        _totalAssets = bound(_totalAssets, 0, type(uint128).max);

        // Must not revert (div-by-zero / underflow / overflow) for any bounded input.
        lib.dilutionShares(
            _feeAssets,
            _totalSupply,
            _totalAssets,
            _decimalsOffset
        );
    }

    /* ----------------------- convertToShares / convertToAssets --------------- */

    // With zero pending fee-shares the conversion is exactly OZ's ERC-4626 formula.
    function test_Convert_ZeroPendingMatchesOzFormula() public view {
        uint256 assets = 5e17;
        uint256 supply = 3e18;
        uint256 total = 2e18;

        uint256 shares = lib.convertToShares({
            _assets: assets,
            _totalSupply: supply,
            _pendingFeeShares: 0,
            _totalAssets: total,
            _decimalsOffset: 0,
            _rounding: Math.Rounding.Floor
        });
        uint256 backAssets = lib.convertToAssets({
            _shares: shares,
            _totalSupply: supply,
            _pendingFeeShares: 0,
            _totalAssets: total,
            _decimalsOffset: 0,
            _rounding: Math.Rounding.Floor
        });

        assertEq(shares, Math.mulDiv(assets, supply + 1, total + 1));
        assertLe(backAssets, assets);
    }

    // Pending dilution shares lower the share price: more shares per asset on the way in,
    // fewer assets per share on the way out.
    function testFuzz_Convert_PendingSharesDilute(
        uint256 _assets,
        uint256 _shares,
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint256 _pending,
        uint8 _decimalsOffset
    ) public view {
        _assets = bound(_assets, 1, type(uint96).max);
        _shares = bound(_shares, 1, type(uint96).max);
        _totalSupply = bound(_totalSupply, 1, type(uint96).max);
        _totalAssets = bound(_totalAssets, 1, type(uint96).max);
        _pending = bound(_pending, 1, type(uint96).max);
        _decimalsOffset = uint8(bound(_decimalsOffset, 0, 12));

        uint256 sharesNoFee = lib.convertToShares({
            _assets: _assets,
            _totalSupply: _totalSupply,
            _pendingFeeShares: 0,
            _totalAssets: _totalAssets,
            _decimalsOffset: _decimalsOffset,
            _rounding: Math.Rounding.Floor
        });
        uint256 sharesWithFee = lib.convertToShares({
            _assets: _assets,
            _totalSupply: _totalSupply,
            _pendingFeeShares: _pending,
            _totalAssets: _totalAssets,
            _decimalsOffset: _decimalsOffset,
            _rounding: Math.Rounding.Floor
        });
        uint256 assetsNoFee = lib.convertToAssets({
            _shares: _shares,
            _totalSupply: _totalSupply,
            _pendingFeeShares: 0,
            _totalAssets: _totalAssets,
            _decimalsOffset: _decimalsOffset,
            _rounding: Math.Rounding.Floor
        });
        uint256 assetsWithFee = lib.convertToAssets({
            _shares: _shares,
            _totalSupply: _totalSupply,
            _pendingFeeShares: _pending,
            _totalAssets: _totalAssets,
            _decimalsOffset: _decimalsOffset,
            _rounding: Math.Rounding.Floor
        });

        assertGe(sharesWithFee, sharesNoFee);
        assertLe(assetsWithFee, assetsNoFee);
    }

    /* ---------------------- pricePerShare / performanceFeeAssets ------------- */

    function test_PricePerShare_EmptyVaultIsOneToOne() public view {
        // (0 + 1) * 1e18 / (0 + 10**offset)
        assertEq(lib.pricePerShare(0, 0, 0), 1e18);
        assertEq(lib.pricePerShare(0, 0, 3), 1e15);
    }

    function testFuzz_PricePerShare_MatchesConvertToAssets(
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint8 _decimalsOffset
    ) public view {
        _totalSupply = bound(_totalSupply, 0, type(uint128).max);
        _totalAssets = bound(_totalAssets, 0, type(uint128).max);
        _decimalsOffset = uint8(bound(_decimalsOffset, 0, 12));

        // The watermark unit is exactly the price a holder converts at: PPS equals
        // convertToAssets(PPS_SCALE) under the same virtual-offset convention.
        assertEq(
            lib.pricePerShare(_totalSupply, _totalAssets, _decimalsOffset),
            lib.convertToAssets({
                _shares: 1e18,
                _totalSupply: _totalSupply,
                _pendingFeeShares: 0,
                _totalAssets: _totalAssets,
                _decimalsOffset: _decimalsOffset,
                _rounding: Math.Rounding.Floor
            })
        );
    }

    function test_PerformanceFee_ZeroInputs() public view {
        assertEq(lib.performanceFeeAssets(0, 1e18, 1e18, 2000, 0), 0);
        assertEq(lib.performanceFeeAssets(1e18, 0, 1e18, 2000, 0), 0);
        assertEq(lib.performanceFeeAssets(1e18, 1e18, 1e18, 0, 0), 0);
    }

    function test_PerformanceFee_NeverChargesAtOrBelowWatermark() public view {
        // PPS exactly at the watermark: no gain.
        uint256 pps = lib.pricePerShare(1e21, 1e21, 0);

        assertEq(lib.performanceFeeAssets(1e21, 1e21, pps, 2000, 0), 0);
        // PPS below the watermark (net loss): no charge.
        assertEq(lib.performanceFeeAssets(9e20, 1e21, pps, 2000, 0), 0);
    }

    function test_PerformanceFee_KnownValue() public view {
        // supply 1000e18, assets 1200e18, hwm 1e18 => gain ~200e18; 20% => ~40e18.
        // The flooring of the PPS quantizes the gain to steps of supply/PPS_SCALE
        // (1000 wei here), always in the holders' favour.
        uint256 fee = lib.performanceFeeAssets(
            1200e18,
            1000e18,
            1e18,
            2000,
            0
        );

        assertLe(fee, 40e18);
        assertApproxEqAbs(fee, 40e18, 1000);
    }

    function testFuzz_PerformanceFee_BoundedByRateTimesGain(
        uint256 _totalSupply,
        uint256 _totalAssets,
        uint256 _hwmPps,
        uint16 _rateBps
    ) public view {
        _totalSupply = bound(_totalSupply, 1, type(uint96).max);
        _totalAssets = bound(_totalAssets, 1, type(uint96).max);
        _hwmPps = bound(_hwmPps, 0, type(uint96).max);
        _rateBps = uint16(bound(_rateBps, 1, 5000));

        uint256 fee = lib.performanceFeeAssets(
            _totalAssets,
            _totalSupply,
            _hwmPps,
            _rateBps,
            0
        );

        uint256 pps = lib.pricePerShare(_totalSupply, _totalAssets, 0);
        if (pps <= _hwmPps) {
            assertEq(fee, 0);
        } else {
            uint256 gain = Math.mulDiv(_totalSupply, pps - _hwmPps, 1e18);
            // feeOnRaw ceil, then clamped strictly below totalAssets.
            assertLe(fee, Math.mulDiv(gain, _rateBps, BPS) + 1);
            assertLt(fee, _totalAssets);
        }
    }

    function testFuzz_PerformanceFee_MonotonicInAssets(
        uint256 _totalSupply,
        uint256 _baseAssets,
        uint256 _yield,
        uint256 _extraYield
    ) public view {
        _totalSupply = bound(_totalSupply, 1e6, type(uint96).max);
        _baseAssets = bound(_baseAssets, 1e6, type(uint96).max);
        _yield = bound(_yield, 1, type(uint96).max);
        _extraYield = bound(_extraYield, 1, type(uint96).max);

        // Watermark anchored at the base level; both measurements sit at or above it,
        // so the property compares two live fee levels, not a fee against zero.
        uint256 hwm = lib.pricePerShare(_totalSupply, _baseAssets, 0);
        uint256 feeLow = lib.performanceFeeAssets(
            _baseAssets + _yield,
            _totalSupply,
            hwm,
            2000,
            0
        );
        uint256 feeHigh = lib.performanceFeeAssets(
            _baseAssets + _yield + _extraYield,
            _totalSupply,
            hwm,
            2000,
            0
        );

        // More yield on the same supply/watermark never charges less.
        assertGe(feeHigh, feeLow);
    }
}
