// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Vm } from "forge-std/Vm.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { ERC4626 } from "solmate/mixins/ERC4626.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";

/// @notice Integration tests for the LiFiVaultWrapper fee engine (EXSC-410): management
///         dilution accrual, the preview==execution invariant, asset-side deposit/withdrawal
///         fees (Convention B), fee-counter saturation, and the `setFeeRate` admin path.
///         Setup and shared helpers live in `VaultWrapperFeeTestBase`.
contract LiFiVaultWrapperFeesTest is VaultWrapperFeeTestBase {
    uint16 internal constant DEP_RATE = 100; // 1%
    uint16 internal constant WD_RATE = 100; // 1%

    /// Management fee accrual ///

    function test_ManagementFeeAccruesProRataOverTime() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        assertEq(_accruedFeeShares(), 0);

        vm.warp(block.timestamp + YEAR);

        (uint256 expectedShares, uint256 expectedAssets) = _expectedMgmt(
            wrapper
        );
        assertGt(expectedShares, 0);

        // A real operation crystallizes pending fees via _beforeOperation -> _accrueFees
        // before its own shares are minted, so the fee bookkeeping is exact regardless of
        // the triggering deposit's size.
        _crystallize();

        assertEq(_accruedFeeShares(), expectedShares);
        assertEq(wrapper.balanceOf(address(wrapper)), expectedShares);
        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);

        // ~2% of AUM over a year, valued back through the new effective supply.
        assertApproxEqRel(
            expectedAssets,
            (DEPOSIT * MGMT_RATE) / 10_000,
            1e15
        );
    }

    function test_PassiveHolderBalanceUnchangedWhilePpsDrops() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        uint256 aliceShares = wrapper.balanceOf(alice);
        uint256 ppsBefore = wrapper.convertToAssets(aliceShares);

        vm.warp(block.timestamp + YEAR);
        _crystallize();

        // U23: the passive holder's share BALANCE is untouched by dilution...
        assertEq(wrapper.balanceOf(alice), aliceShares);
        // ...but each share now redeems for fewer assets (PPS dropped).
        uint256 ppsAfter = wrapper.convertToAssets(aliceShares);
        assertLt(ppsAfter, ppsBefore);
    }

    function test_ZeroElapsedDoesNotAccrue() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        uint256 wrapperSharesBefore = wrapper.balanceOf(address(wrapper));

        // Same block => elapsed 0 => no accrual.
        _crystallize();

        assertEq(wrapper.balanceOf(address(wrapper)), wrapperSharesBefore);
        assertEq(_accruedFeeShares(), 0);
    }

    function test_DisabledManagementFeeDoesNotAccrue() public {
        wrapper = _newWrapperMgmtOnly(0); // disabled
        _deposit(alice, DEPOSIT);

        uint256 wrapperSharesBefore = wrapper.balanceOf(address(wrapper));

        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertEq(wrapper.balanceOf(address(wrapper)), wrapperSharesBefore);
        assertEq(_accruedFeeShares(), 0);
    }

    function test_ManagementFeeNoAccrualOnEmptyVault() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);

        // No prior deposits: totalSupply()/totalAssets() are zero, so the accrual at the
        // top of the first operation finds nothing to dilute.
        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertEq(_accruedFeeShares(), 0);
    }

    function test_ZeroShareAccrualStillAdvancesBaseline() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        // A tiny AUM makes the per-second management fee floor to zero shares, so the
        // accrual at the top of an operation mints nothing.
        _deposit(alice, 1000);

        vm.warp(block.timestamp + 1);
        _crystallize();

        assertEq(_accruedFeeShares(), 0);
        // The baseline still advances: sub-threshold elapsed time is dropped (favouring
        // holders), never carried forward to be re-priced against a larger future AUM.
        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);
    }

    function test_DormantDustVaultCannotChargeNewDepositorForPastTime()
        public
    {
        wrapper = _newWrapperMgmtOnly(1000); // 10% / year
        // Dust-seed the vault, then leave it dormant: at 10 wei AUM the management fee
        // floors to zero shares at every accrual.
        _deposit(alice, 10);

        vm.warp(block.timestamp + YEAR - 1);

        // The accrual at the top of this large deposit still floors to zero at the
        // pre-deposit AUM, but the baseline must advance so the dormant year cannot be
        // re-priced against the new depositor's assets.
        _deposit(bob, 1_000_000e18);

        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);

        vm.warp(block.timestamp + 1);
        _crystallize();

        // One second at 10%/yr on ~1e24 assets is ~3e15 fee-shares; carrying the dormant
        // year would have charged ~1e23 (10% of bob's deposit). Assert second-scale.
        assertGt(_accruedFeeShares(), 0);
        assertLt(_accruedFeeShares(), 1e18);
    }

    function test_DilutionFeeAccruedEventEmitted() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        vm.warp(block.timestamp + YEAR);
        (uint256 expectedShares, ) = _expectedMgmt(wrapper);

        // The crystallizing op also emits ERC20 Transfers (fee-share mint, deposit-share
        // mint); scan recorded logs for the DilutionFeeAccrued rather than asserting it is
        // the next event.
        vm.recordLogs();
        _crystallize();

        bytes32 sig = keccak256("DilutionFeeAccrued(uint8,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            assertEq(logs[i].emitter, address(wrapper));
            assertEq(
                uint256(logs[i].topics[1]),
                uint256(uint8(FeeType.Management))
            );
            (uint256 shares, uint256 integratorShares) = abi.decode(
                logs[i].data,
                (uint256, uint256)
            );
            assertEq(shares, expectedShares);
            assertEq(integratorShares, (expectedShares * SPLIT) / 10_000);
            ++matches;
        }
        assertEq(matches, 1);
    }

    /// Preview == execution invariant (headline) ///

    function test_PreviewDepositMatchesExecutionWithPendingMgmt() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        asset.mint(bob, DEPOSIT);
        vm.startPrank(bob);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 previewed = wrapper.previewDeposit(DEPOSIT);
        uint256 minted = wrapper.deposit(DEPOSIT, bob);
        vm.stopPrank();

        assertEq(minted, previewed);
    }

    function test_PreviewMintMatchesExecutionWithPendingMgmt() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        uint256 sharesWanted = 500e18;
        uint256 previewedAssets = wrapper.previewMint(sharesWanted);

        asset.mint(bob, previewedAssets);
        vm.startPrank(bob);
        asset.approve(address(wrapper), previewedAssets);
        uint256 assetsIn = wrapper.mint(sharesWanted, bob);
        vm.stopPrank();

        assertEq(assetsIn, previewedAssets);
        assertEq(wrapper.balanceOf(bob), sharesWanted);
    }

    function test_PreviewWithdrawMatchesExecutionWithPendingMgmt() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        uint256 assetsWanted = 300e18;
        uint256 previewedShares = wrapper.previewWithdraw(assetsWanted);

        vm.prank(alice);
        uint256 sharesBurned = wrapper.withdraw(assetsWanted, alice, alice);

        assertEq(sharesBurned, previewedShares);
        assertEq(asset.balanceOf(alice), assetsWanted);
    }

    function test_PreviewRedeemMatchesExecutionWithPendingMgmt() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);
        vm.warp(block.timestamp + YEAR);

        uint256 sharesToRedeem = wrapper.balanceOf(alice) / 2;
        uint256 previewedAssets = wrapper.previewRedeem(sharesToRedeem);

        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(sharesToRedeem, alice, alice);

        assertEq(assetsOut, previewedAssets);
    }

    function test_PreviewMatchesExecutionWithMgmtAndYieldAndAssetFees()
        public
    {
        wrapper = _newWrapperAllThree(MGMT_RATE, DEP_RATE, WD_RATE);
        _deposit(alice, DEPOSIT);

        _simulateYield(150e18);
        vm.warp(block.timestamp + YEAR);

        asset.mint(bob, DEPOSIT);
        vm.startPrank(bob);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 previewedShares = wrapper.previewDeposit(DEPOSIT);
        uint256 mintedShares = wrapper.deposit(DEPOSIT, bob);
        assertEq(mintedShares, previewedShares);

        uint256 previewedAssets = wrapper.previewRedeem(mintedShares);
        uint256 redeemedAssets = wrapper.redeem(mintedShares, bob, bob);
        vm.stopPrank();

        assertEq(redeemedAssets, previewedAssets);
    }

    /// Asset-side deposit / withdrawal fees (Convention B) ///

    function test_DepositFeeIsHeldIdleAndDoesNotMovePps() public {
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT); // seed so PPS is well-defined

        uint256 ppsBefore = wrapper.convertToAssets(1e18);
        uint256 totalAssetsBefore = wrapper.totalAssets();
        uint256 feeAssetsBefore = _accruedFeeAssets();
        uint256 idleBefore = asset.balanceOf(address(wrapper));

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnTotal(amount, DEP_RATE);
        uint256 netInvested = amount - expectedFee;

        asset.mint(bob, amount);
        vm.startPrank(bob);
        asset.approve(address(wrapper), amount);
        uint256 minted = wrapper.deposit(amount, bob);
        vm.stopPrank();

        // bob's shares reflect only the NET (post-fee) amount.
        assertEq(minted, wrapper.previewDeposit(amount));
        // fee assets are tracked and stay idle in the wrapper (not invested).
        assertEq(_accruedFeeAssets(), feeAssetsBefore + expectedFee);
        assertEq(asset.balanceOf(address(wrapper)), idleBefore + expectedFee);
        // only the net amount reached the yield source...
        assertEq(wrapper.totalAssets(), totalAssetsBefore + netInvested);
        // ...so the fee event itself leaves PPS unchanged (no yield, fee held aside).
        assertEq(wrapper.convertToAssets(1e18), ppsBefore);
    }

    function test_WithdrawalFeeIsHeldIdleAndDoesNotMovePps() public {
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);

        uint256 ppsBefore = wrapper.convertToAssets(1e18);

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnRaw(amount, WD_RATE);

        vm.prank(alice);
        wrapper.withdraw(amount, alice, alice);

        // alice receives exactly the requested amount; the fee is redeemed on top.
        assertEq(asset.balanceOf(alice), amount);
        assertEq(_accruedFeeAssets(), expectedFee);
        assertEq(asset.balanceOf(address(wrapper)), expectedFee);
        // PPS for the remaining holders is unaffected by the fee event.
        assertEq(wrapper.convertToAssets(1e18), ppsBefore);
    }

    function test_DepositMintInverseWithFee() public {
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT);

        uint256 amount = 100e18;
        uint256 sharesFromDeposit = wrapper.previewDeposit(amount);
        uint256 assetsForThoseShares = wrapper.previewMint(sharesFromDeposit);

        // depositing `amount` and minting the resulting shares cost the same gross assets.
        assertApproxEqAbs(assetsForThoseShares, amount, 1);
    }

    function test_MintWithDepositFeeChargesPreviewedGross() public {
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT);

        uint256 sharesWanted = 100e18;
        uint256 previewedGross = wrapper.previewMint(sharesWanted);
        uint256 feeAssetsBefore = _accruedFeeAssets();
        uint256 totalAssetsBefore = wrapper.totalAssets();

        asset.mint(bob, previewedGross);
        vm.startPrank(bob);
        asset.approve(address(wrapper), previewedGross);
        uint256 paid = wrapper.mint(sharesWanted, bob);
        vm.stopPrank();

        // The executed mint pulls exactly the previewed gross for exactly the requested
        // shares, and the fee recomputed on-chain from the gross matches the booked
        // amount — the rest of the gross reached the yield source.
        uint256 expectedFee = LibVaultWrapperMath.feeOnTotal(
            previewedGross,
            DEP_RATE
        );
        assertEq(paid, previewedGross);
        assertEq(wrapper.balanceOf(bob), sharesWanted);
        assertEq(_accruedFeeAssets() - feeAssetsBefore, expectedFee);
        assertEq(
            wrapper.totalAssets() - totalAssetsBefore,
            previewedGross - expectedFee
        );
    }

    function test_FullExitViaMaxWithdrawWithWithdrawalFee() public {
        // The classic ERC-4626 fee-wrapper failure: the exit fee pushes the share burn
        // for withdraw(maxWithdraw(owner)) above the holder's balance. Guards the
        // maxWithdraw == previewRedeem(maxRedeem(owner)) semantics the wrapper relies on.
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);
        _simulateYield(50e18); // non-trivial PPS so rounding paths are exercised

        uint256 sharesBefore = wrapper.balanceOf(alice);
        uint256 maxAssets = wrapper.maxWithdraw(alice);
        uint256 previewedShares = wrapper.previewWithdraw(maxAssets);

        vm.prank(alice);
        uint256 burned = wrapper.withdraw(maxAssets, alice, alice);

        assertEq(burned, previewedShares);
        assertLe(burned, sharesBefore);
        assertEq(asset.balanceOf(alice), maxAssets);
        // At most rounding dust may remain; a full exit must never revert.
        assertLe(wrapper.balanceOf(alice), 2);
    }

    function test_WithdrawRedeemInverseWithFee() public {
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);

        uint256 amount = 100e18;
        uint256 sharesForWithdraw = wrapper.previewWithdraw(amount);
        uint256 assetsFromRedeem = wrapper.previewRedeem(sharesForWithdraw);

        // withdrawing `amount` burns the same shares that redeeming yields `amount` back.
        assertApproxEqAbs(assetsFromRedeem, amount, 1);
    }

    function test_AssetFeeChargedEventEmittedOnDeposit() public {
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT);

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnTotal(amount, DEP_RATE);

        asset.mint(bob, amount);
        vm.startPrank(bob);
        asset.approve(address(wrapper), amount);

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit AssetFeeCharged(
            FeeType.Deposit,
            expectedFee,
            (expectedFee * SPLIT) / 10_000
        );

        wrapper.deposit(amount, bob);
        vm.stopPrank();
    }

    function test_AssetFeeChargedEventEmittedOnWithdrawal() public {
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnRaw(amount, WD_RATE);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(wrapper));
        emit AssetFeeCharged(
            FeeType.Withdrawal,
            expectedFee,
            (expectedFee * SPLIT) / 10_000
        );

        wrapper.withdraw(amount, alice, alice);
    }

    function test_PreviewDepositMatchesExecutionOnSubFeeDust() public {
        // At a 1% deposit fee, feeOnTotal(1) = ceil(1*100/10100) = 1, so the net invested
        // amount rounds to 0. previewDeposit(1) returns 0; deposit(1) must not revert (the
        // wrapper skips the zero forward the underlying would reject) and must mint the same.
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT);

        uint256 feeBefore = _accruedFeeAssets();
        uint256 idleBefore = asset.balanceOf(address(wrapper));

        uint256 dust = 1;
        uint256 previewed = wrapper.previewDeposit(dust);
        assertEq(previewed, 0);

        asset.mint(bob, dust);
        vm.startPrank(bob);
        asset.approve(address(wrapper), dust);
        uint256 minted = wrapper.deposit(dust, bob);
        vm.stopPrank();

        assertEq(minted, previewed);
        // The whole dust input was carved as fee and held idle; nothing reached the source.
        assertEq(_accruedFeeAssets(), feeBefore + dust);
        assertEq(asset.balanceOf(address(wrapper)), idleBefore + dust);
    }

    function test_DustRedeemSucceedsOnZeroRejectingSource() public {
        // A yield source that rejects zero-amount withdrawals must not block a dust
        // redeem whose previewRedeem is 0: the wrapper skips the adapter round-trip
        // entirely (mirroring the zero short-circuit on the deposit side).
        underlying = MockERC4626(
            address(new ZeroWithdrawRevertingERC4626(asset))
        );
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);

        // A single share's gross value (1 wei) is fully consumed by the exit fee.
        vm.prank(alice);
        wrapper.transfer(bob, 1);

        assertEq(wrapper.previewRedeem(1), 0);

        vm.prank(bob);
        uint256 out = wrapper.redeem(1, bob, bob);

        assertEq(out, 0);
        assertEq(wrapper.balanceOf(bob), 0);
    }

    function test_AdapterWithdrawalOverageIsBookedNotStranded() public {
        // A round-up source pays 1 wei more than owed on every withdrawal; the overage
        // must be booked with the fee, not stranded as untracked idle assets.
        underlying = MockERC4626(address(new OverpayingERC4626(asset)));
        wrapper = _newWrapperAssetFees(0, WD_RATE);
        _deposit(alice, DEPOSIT);
        _simulateYield(10e18); // spare balance the source overpays from

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnRaw(amount, WD_RATE);

        vm.prank(alice);
        wrapper.withdraw(amount, alice, alice);

        assertEq(asset.balanceOf(alice), amount);
        // Fee + overage are both attributed, so booked == idle to the wei.
        assertEq(_accruedFeeAssets(), expectedFee + 1);
        assertEq(asset.balanceOf(address(wrapper)), expectedFee + 1);
    }

    /// Zero-fee passthrough ///

    function test_ZeroFeeConfigIsPurePassthrough() public {
        FeeConfig memory fees; // all disabled, all zero
        wrapper = _newWrapper(fees);
        _deposit(alice, DEPOSIT);

        _simulateYield(50e18);
        vm.warp(block.timestamp + YEAR);

        uint256 shares = wrapper.balanceOf(alice);
        uint256 previewed = wrapper.previewRedeem(shares);

        vm.prank(alice);
        uint256 out = wrapper.redeem(shares, alice, alice);

        assertEq(out, previewed);
        assertApproxEqAbs(out, DEPOSIT + 50e18, 1);
        assertEq(_accruedFeeShares(), 0);
        assertEq(_accruedFeeAssets(), 0);
    }

    /// Per-fee-type LI.FI/integrator split (applied at accrual) ///

    function test_AssetFeeSplitUsesEachFeeTypesOwnShare() public {
        uint16[4] memory rates = [uint16(0), 0, DEP_RATE, WD_RATE];
        bool[4] memory enabled = [false, false, true, true];
        // Distinct shares per fee type: deposit 30% / withdrawal 40% to the integrator.
        wrapper = _newWrapperWithSplits(
            FeeConfig({ rateBps: rates, enabled: enabled }),
            [uint16(0), 0, 3000, 4000]
        );
        _deposit(alice, DEPOSIT);

        uint256 depFee = LibVaultWrapperMath.feeOnTotal(DEPOSIT, DEP_RATE);
        uint256 depIntegrator = (depFee * 3000) / 10_000;
        assertEq(wrapper.integratorFeeAssets(), depIntegrator);
        assertEq(wrapper.lifiFeeAssets(), depFee - depIntegrator);

        uint256 amount = 100e18;
        uint256 wdFee = LibVaultWrapperMath.feeOnRaw(amount, WD_RATE);
        uint256 wdIntegrator = (wdFee * 4000) / 10_000;

        vm.prank(alice);
        wrapper.withdraw(amount, alice, alice);

        assertEq(wrapper.integratorFeeAssets(), depIntegrator + wdIntegrator);
        assertEq(
            wrapper.lifiFeeAssets(),
            (depFee - depIntegrator) + (wdFee - wdIntegrator)
        );
    }

    function test_DilutionFeeSplitUsesManagementShare() public {
        uint16[4] memory rates = [uint16(0), MGMT_RATE, 0, 0];
        bool[4] memory enabled = [false, true, false, false];
        wrapper = _newWrapperWithSplits(
            FeeConfig({ rateBps: rates, enabled: enabled }),
            [uint16(0), 2500, 0, 0]
        );
        _deposit(alice, DEPOSIT);

        vm.warp(block.timestamp + YEAR);
        (uint256 expectedShares, ) = _expectedMgmt(wrapper);
        assertGt(expectedShares, 0);

        _crystallize();

        uint256 integratorPart = (expectedShares * 2500) / 10_000;
        assertEq(wrapper.integratorFeeShares(), integratorPart);
        assertEq(wrapper.lifiFeeShares(), expectedShares - integratorPart);
        // The wrapper custodies the total; the split is bookkeeping only.
        assertEq(wrapper.balanceOf(address(wrapper)), expectedShares);
    }

    function test_SplitRoundingRemainderGoesToLifi() public {
        uint16[4] memory rates = [uint16(0), 0, DEP_RATE, 0];
        bool[4] memory enabled = [false, false, true, false];
        wrapper = _newWrapperWithSplits(
            FeeConfig({ rateBps: rates, enabled: enabled }),
            [uint16(0), 0, 3333, 0]
        );
        _deposit(alice, DEPOSIT);

        uint256 fee = LibVaultWrapperMath.feeOnTotal(DEPOSIT, DEP_RATE);
        uint256 integratorPart = (fee * 3333) / 10_000;
        // The integrator's part rounds down and the split dust goes to LI.FI, so the
        // two counters always sum to the full fee.
        assertEq(wrapper.integratorFeeAssets(), integratorPart);
        assertEq(wrapper.lifiFeeAssets(), fee - integratorPart);
        assertEq(_accruedFeeAssets(), fee);
    }

    /// Fee counter saturation ///

    function test_FeeCounterSaturationNeverBricksExits() public {
        // Books fee-shares beyond uint128 max in a single management accrual: a large
        // wei-supply left dormant long enough that the fee clamps to ~all of AUM, so
        // dilutionShares explodes to ~supply * assets / 2 (~5e75 here). The counters
        // must saturate — never revert — because the accrual runs on every exit and
        // even on the fee-disable path.
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        uint256 whale = 1e38; // large, but within solmate's mock 4626 mulDiv range
        _deposit(alice, whale);

        vm.warp(block.timestamp + 500 * YEAR);
        _crystallize();

        assertEq(wrapper.integratorFeeShares(), type(uint128).max);
        assertEq(wrapper.lifiFeeShares(), type(uint128).max);

        // A further accrual on the saturated counters still cannot revert.
        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertEq(wrapper.integratorFeeShares(), type(uint128).max);
        assertEq(wrapper.lifiFeeShares(), type(uint128).max);

        // Exits stay live (the dilution left alice only dust to withdraw, but the
        // accrual in the exit path must not revert)...
        uint256 maxOut = wrapper.maxWithdraw(alice);
        vm.prank(alice);
        wrapper.withdraw(maxOut, alice, alice);

        assertEq(asset.balanceOf(alice), maxOut);

        // ...and the fee can still be disabled (setFeeRate accrues first).
        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 0);

        assertFalse(wrapper.feeEnabled(uint8(FeeType.Management)));
    }

    /// setFeeRate ///

    function test_SetFeeRateUpdatesManagementWithinBounds() public {
        _stackWithFactory(MGMT_RATE);

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit FeeConfigUpdated(FeeType.Management, 500, true);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 500);

        assertEq(wrapper.feeRate(uint8(FeeType.Management)), 500);
        assertTrue(wrapper.feeEnabled(uint8(FeeType.Management)));
    }

    function test_SetFeeRateZeroDisablesAndSkipsBounds() public {
        _stackWithFactory(MGMT_RATE);
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Management, 100, 1000);

        vm.expectEmit(true, false, false, true, address(wrapper));
        emit FeeConfigUpdated(FeeType.Management, 0, false);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 0);

        assertEq(wrapper.feeRate(uint8(FeeType.Management)), 0);
        assertFalse(wrapper.feeEnabled(uint8(FeeType.Management)));
    }

    function testRevert_SetFeeRateNonAdmin() public {
        _stackWithFactory(MGMT_RATE);

        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        wrapper.setFeeRate(FeeType.Management, 500);
    }

    function testRevert_SetFeeRateAboveBound() public {
        _stackWithFactory(MGMT_RATE); // mgmt bounds set to 0..1000

        vm.prank(vaultAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.FeeRateOutOfBounds.selector,
                uint16(1001),
                uint16(0),
                uint16(1000)
            )
        );
        wrapper.setFeeRate(FeeType.Management, 1001);
    }

    function testRevert_SetFeeRateBelowMinBound() public {
        _stackWithFactory(MGMT_RATE);
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Management, 100, 1000);

        vm.prank(vaultAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.FeeRateOutOfBounds.selector,
                uint16(50),
                uint16(100),
                uint16(1000)
            )
        );
        wrapper.setFeeRate(FeeType.Management, 50);
    }

    function test_SetFeeRateAccruesBeforeChange() public {
        _stackWithFactory(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        vm.warp(block.timestamp + YEAR);
        (uint256 expectedShares, ) = _expectedMgmt(wrapper);
        assertGt(expectedShares, 0);

        // Raising the rate must NOT retroactively reprice the elapsed year: the setter
        // accrues at the OLD rate first, so accruedFeeShares equals the old-rate amount.
        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 1000);

        assertEq(_accruedFeeShares(), expectedShares);
        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);
    }

    function test_SetFeeRateAdvancesBaselineEvenWhenAccrualFloorsToZero()
        public
    {
        _stackWithFactory(MGMT_RATE);
        _deposit(alice, 10); // dust: the old-rate accrual floors to zero shares

        vm.warp(block.timestamp + 30 days);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Management, 1000);

        // The elapsed month was priced (to zero) at the old rate and dropped; it must
        // not be re-priced at the new 10% rate by the next accrual.
        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);
        assertEq(_accruedFeeShares(), 0);
    }

    function test_SetFeeRateDepositChargesNewRateOnNextDeposit() public {
        _stackWithFactory(0); // no management fee, so fee effects are isolated
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Deposit, 0, 1000);
        _deposit(alice, DEPOSIT);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Deposit, DEP_RATE);

        // Only the Deposit slot changed.
        assertEq(wrapper.feeRate(uint8(FeeType.Deposit)), DEP_RATE);
        assertTrue(wrapper.feeEnabled(uint8(FeeType.Deposit)));
        assertEq(wrapper.feeRate(uint8(FeeType.Management)), 0);
        assertEq(wrapper.feeRate(uint8(FeeType.Withdrawal)), 0);

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnTotal(amount, DEP_RATE);

        asset.mint(bob, amount);
        vm.startPrank(bob);
        asset.approve(address(wrapper), amount);
        wrapper.deposit(amount, bob);
        vm.stopPrank();

        assertEq(_accruedFeeAssets(), expectedFee);
    }

    function test_SetFeeRateWithdrawalChargesNewRateOnNextWithdraw() public {
        _stackWithFactory(0);
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Withdrawal, 0, 1000);
        _deposit(alice, DEPOSIT);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Withdrawal, WD_RATE);

        assertEq(wrapper.feeRate(uint8(FeeType.Withdrawal)), WD_RATE);
        assertTrue(wrapper.feeEnabled(uint8(FeeType.Withdrawal)));

        uint256 amount = 100e18;
        uint256 expectedFee = LibVaultWrapperMath.feeOnRaw(amount, WD_RATE);

        vm.prank(alice);
        wrapper.withdraw(amount, alice, alice);

        assertEq(asset.balanceOf(alice), amount);
        assertEq(_accruedFeeAssets(), expectedFee);
    }

    function testRevert_SetFeeRateDepositValidatedAgainstDepositBounds()
        public
    {
        _stackWithFactory(0); // management bounds are 0..1000
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Deposit, 200, 1000);

        // 100 bps sits inside the management bounds but below the deposit minimum, so
        // the setter must be reading the DEPOSIT bounds to reject it.
        vm.prank(vaultAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.FeeRateOutOfBounds.selector,
                uint16(100),
                uint16(200),
                uint16(1000)
            )
        );

        wrapper.setFeeRate(FeeType.Deposit, 100);
    }

    /// Helpers ///

    function _newWrapperMgmtOnly(
        uint16 _rate
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [uint16(0), _rate, 0, 0];
        bool[4] memory enabled = [false, _rate != 0, false, false];

        return _newWrapper(FeeConfig({ rateBps: rates, enabled: enabled }));
    }

    function _newWrapperAssetFees(
        uint16 _depRate,
        uint16 _wdRate
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [uint16(0), 0, _depRate, _wdRate];
        bool[4] memory enabled = [false, false, _depRate != 0, _wdRate != 0];

        return _newWrapper(FeeConfig({ rateBps: rates, enabled: enabled }));
    }

    function _newWrapperAllThree(
        uint16 _mgmt,
        uint16 _dep,
        uint16 _wd
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [uint16(0), _mgmt, _dep, _wd];
        bool[4] memory enabled = [false, true, true, true];

        return _newWrapper(FeeConfig({ rateBps: rates, enabled: enabled }));
    }

    /// @dev Stands up the full factory stack and deploys a management-fee instance so
    ///      `setFeeRate` reads live `feeBounds` (mgmt bounds 0..1000).
    function _stackWithFactory(uint16 _mgmtRate) internal {
        _stackWithFactory(FeeType.Management, _mgmtRate, 1000);
    }

    function _expectedMgmt(
        LiFiVaultWrapper _w
    ) internal view returns (uint256 feeShares, uint256 feeAssets) {
        uint256 supply = _w.totalSupply();
        uint256 assets = _w.totalAssets();
        uint256 elapsed = block.timestamp - _w.lastMgmtAccrual();

        feeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: assets,
            _rateBps: MGMT_RATE,
            _elapsed: elapsed
        });
        feeShares = LibVaultWrapperMath.dilutionShares({
            _feeAssets: feeAssets,
            _totalSupply: supply,
            _totalAssets: assets,
            _decimalsOffset: 0
        });
    }
}

/// @dev A yield source that rejects zero-amount withdrawals, mirroring vaults with
///      non-standard zero handling (solmate's MockERC4626 hooks are not virtual, so this
///      subclasses the mixin directly).
contract ZeroWithdrawRevertingERC4626 is ERC4626 {
    error ZeroAssets();

    constructor(ERC20 _asset) ERC4626(_asset, "Strict Yield Token", "syTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function beforeWithdraw(uint256 _assets, uint256) internal pure override {
        if (_assets == 0) revert ZeroAssets();
    }
}

/// @dev A yield source that pays 1 wei more than requested on every withdrawal,
///      mirroring round-up sources (e.g. liquidity-index markets); the extra wei comes
///      out of the source's idle balance.
contract OverpayingERC4626 is ERC4626 {
    using SafeTransferLib for ERC20;

    constructor(
        ERC20 _asset
    ) ERC4626(_asset, "Generous Yield Token", "gyTKN") {}

    function totalAssets() public view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function withdraw(
        uint256 _assets,
        address _receiver,
        address _owner
    ) public override returns (uint256 shares) {
        shares = super.withdraw(_assets, _receiver, _owner);
        asset.safeTransfer(_receiver, 1);
    }
}
