// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
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

        // Bob seeds then exits down to dust supply (below DUST_SUPPLY_THRESHOLD) — a
        // regime where the perf dilution floors to zero and the watermark never ratchets.
        _deposit(bob, DEPOSIT);
        uint256 bobShares = wrapper.balanceOf(bob);
        vm.prank(bob);
        wrapper.redeem(bobShares - 1, bob, bob);

        assertGt(wrapper.totalSupply(), 0);
        assertLt(wrapper.totalSupply(), DUST_SUPPLY_THRESHOLD);

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

    function test_PreviewDepositMatchesExecutionAtDustSupply() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);

        // Dust supply with pps pushed above the watermark: the accrual skips the perf
        // mint, so the preview must not quote pending perf shares either (EIP-4626:
        // previewDeposit must not overstate what the deposit mints). Enough real
        // shares are left that the pending perf dilution itself is non-zero.
        _deposit(bob, DEPOSIT);
        uint256 toRedeem = wrapper.balanceOf(bob) - DUST_SUPPLY_THRESHOLD / 2;
        vm.prank(bob);
        wrapper.redeem(toRedeem, bob, bob);

        assertLt(wrapper.totalSupply(), DUST_SUPPLY_THRESHOLD);

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

    function test_PricePerShareCeilRoundsUpAndDefaultFloors() public pure {
        uint256 floored = LibVaultWrapperMath.pricePerShare(
            2,
            6,
            0,
            Math.Rounding.Floor
        );
        uint256 ceiled = LibVaultWrapperMath.pricePerShare(
            2,
            6,
            0,
            Math.Rounding.Ceil
        );

        // 7e18 / 3 is not exact: ceil is exactly one unit above floor.
        assertEq(floored, 2333333333333333333);
        assertEq(ceiled, 2333333333333333334);

        // The parameterless overload keeps the floored measurement convention.
        assertEq(LibVaultWrapperMath.pricePerShare(2, 6, 0), floored);
    }
}

/// @notice Second defect in isolation: a 6-decimal asset (one price-per-share step is a
///         whole unit of a 1M vault) taking frequent sub-step yield. Deployed through the
///         real factory stack so `distributeFees` (a principal-free, permissionless accrual
///         trigger) is available. The pre-fix floored watermark re-charged a full step each
///         crossing, confiscating ~76% of the yield; the fix caps it at the configured 20%.
contract PerfFeeLowDecimalOverchargeTest is VaultWrapperFeeTestBase {
    uint16 internal constant PERF_RATE = 2000; // 20% of gains

    function setUp() public override {
        asset = new MockERC20("USD Coin", "USDC", 6);
        underlying = new MockERC4626(asset, "Yield USDC", "yUSDC");
        adapter = new ERC4626Adapter();
        _stackWithFactory(FeeType.Performance, PERF_RATE, 5000);
    }

    function test_LowDecimalPerfFeeDoesNotOverchargeAcrossManyAccruals()
        public
    {
        uint256 principal = 1_000_000e6;
        _deposit(alice, principal);

        uint256 drip = 210_000; // 0.21 USDC, below the 1 USDC price-per-share step
        uint256 rounds = 400;
        for (uint256 i = 0; i < rounds; i++) {
            _simulateYield(drip);
            wrapper.distributeFees();
        }
        wrapper.distributeFees();

        uint256 totalYield = drip * rounds;

        uint256 aliceShares = wrapper.balanceOf(alice);
        vm.prank(alice);
        uint256 aliceOut = wrapper.redeem(aliceShares, alice, alice);

        // Holder keeps the large majority of the yield: the cap is 20% and the floored
        // measurement only ever under-charges. The pre-fix re-flooring left the holder
        // <25%; here they retain well over half.
        assertGe(aliceOut, principal + (totalYield * 60) / 100);
        assertLe(aliceOut, principal + totalYield);
    }
}
