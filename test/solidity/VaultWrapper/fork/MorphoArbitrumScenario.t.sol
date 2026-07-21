// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperForkTestBase } from "test/solidity/VaultWrapper/fork/VaultWrapperForkTestBase.sol";

/// @notice Multi-actor scenario (EXSC-421 / S12) run over a REAL MetaMorpho vault on
///         Arbitrum. Three depositors enter and exit across ~180-day warps while all four
///         fee types are live; yield comes from the vault's native interest accrual, not a
///         simulated donation. Asserts, per operation: deposit/withdrawal asset fees exactly,
///         management/performance dilution against an independent `LibVaultWrapperMath`
///         recomputation, and a non-decreasing high-water mark. Then settles the whole
///         system — fee-distribution fan-out to the two integrator wallets + LI.FI, full drain — and
///         checks nothing is stranded and real positive yield was distributed. A second test
///         proves withdrawals stay open while deposits are paused.
contract MorphoArbitrumScenarioTest is VaultWrapperForkTestBase {
    // Gauntlet USDC Core MetaMorpho vault (asset = native USDC, 6 decimals). Real, live,
    // interest-bearing at the pinned block, so `vm.warp` moves its share price.
    address internal constant MORPHO_GAUNTLET_USDC_CORE =
        0x7e97fa6893871A2751B5fE961978DCCb2c201E65;

    uint256 internal constant WARP = 180 days;

    // Tolerances: withdrawal-fee counter may pick up a few wei of adapter round-up overage
    // (booked with the fee); the drained wrapper keeps sub-cent virtual-offset/flooring dust.
    uint256 internal constant WITHDRAW_TOL = 3;
    uint256 internal constant DRAIN_DUST = 1000; // 0.001 USDC

    function _rpcEnvVar() internal pure override returns (string memory) {
        return "ETH_NODE_URI_ARBITRUM";
    }

    function _forkBlock() internal pure override returns (uint256) {
        return 480_000_000;
    }

    function _underlyingVault() internal pure override returns (address) {
        return MORPHO_GAUNTLET_USDC_CORE;
    }

    /// The end-to-end multi-actor lifecycle with every fee type engaged.
    function test_multiActorLifecycleAccruesAllFeeTypes() public {
        // Alice enters first: only the deposit fee, no dilution (empty vault).
        _enter(alice, 10_000e6);

        // Time passes, the vault accrues, Bob enters at the higher share price. Alice's
        // period now crystallizes into management + performance dilution.
        _warpWithAccrual(WARP);
        uint256 bobDilution = _enter(bob, 20_000e6);
        assertGt(bobDilution, 0, "no dilution accrued over first period");

        // More accrual, Alice exits half — withdrawal fee plus a fresh crystallization.
        _warpWithAccrual(WARP);
        _exit(alice, wrapper.balanceOf(alice) / 2);

        // Carol enters late at the highest share price.
        _warpWithAccrual(WARP);
        _enter(carol, 15_000e6);

        // Final accrual, everyone exits fully.
        _warpWithAccrual(WARP);
        _exit(bob, wrapper.balanceOf(bob));
        _exit(carol, wrapper.balanceOf(carol));
        _exit(alice, wrapper.balanceOf(alice));

        _distributeFeesAndAssertFanOut();
        _drainAndAssertConservation();
    }

    /// Deposits revert while paused; withdrawals stay open (withdrawals-always-open).
    function test_withdrawalsRemainOpenWhilePaused() public {
        uint256 shares = _deposit(alice, 10_000e6);

        vm.prank(vaultAdmin);
        wrapper.pause();

        assertTrue(wrapper.depositsPaused());

        vm.startPrank(bob);
        asset.approve(address(wrapper), 5_000e6);
        vm.expectRevert(ILiFiVaultWrapper.DepositsPaused.selector);
        wrapper.deposit(5_000e6, bob);
        vm.stopPrank();

        uint256 balBefore = asset.balanceOf(alice);
        _redeem(alice, shares);

        assertGt(
            asset.balanceOf(alice),
            balBefore,
            "withdrawal blocked by pause"
        );
    }

    /// @dev Deposits `_assets`, asserting the deposit fee exactly and the crystallized
    ///      dilution against an independent recomputation; returns the dilution charged.
    function _enter(
        address _from,
        uint256 _assets
    ) internal returns (uint256 dilution) {
        uint256 expectedDilution = _expectedDilution(
            wrapper.totalSupply(),
            wrapper.totalAssets()
        );
        uint256 expectedFee = LibVaultWrapperMath.feeOnTotal(
            _assets,
            DEPOSIT_RATE
        );
        uint256 sharesBefore = _accruedFeeShares();
        uint256 assetsBefore = _accruedFeeAssets();
        uint256 hwmBefore = wrapper.perfHighWaterMarkPps();

        _deposit(_from, _assets);

        assertEq(
            _accruedFeeShares() - sharesBefore,
            expectedDilution,
            "deposit dilution mismatch"
        );
        assertEq(
            _accruedFeeAssets() - assetsBefore,
            expectedFee,
            "deposit fee mismatch"
        );
        assertGe(
            wrapper.perfHighWaterMarkPps(),
            hwmBefore,
            "high-water mark dropped"
        );

        return expectedDilution;
    }

    /// @dev Redeems `_shares`, asserting the crystallized dilution exactly and the withdrawal
    ///      fee (net-of-overage) against the assets actually paid out.
    function _exit(address _from, uint256 _shares) internal {
        uint256 expectedDilution = _expectedDilution(
            wrapper.totalSupply(),
            wrapper.totalAssets()
        );
        uint256 sharesBefore = _accruedFeeShares();
        uint256 assetsBefore = _accruedFeeAssets();
        uint256 hwmBefore = wrapper.perfHighWaterMarkPps();

        uint256 received = _redeem(_from, _shares);
        uint256 expectedFee = LibVaultWrapperMath.feeOnRaw(
            received,
            WITHDRAWAL_RATE
        );

        assertEq(
            _accruedFeeShares() - sharesBefore,
            expectedDilution,
            "withdraw dilution mismatch"
        );
        assertApproxEqAbs(
            _accruedFeeAssets() - assetsBefore,
            expectedFee,
            WITHDRAW_TOL,
            "withdraw fee mismatch"
        );
        assertGe(
            wrapper.perfHighWaterMarkPps(),
            hwmBefore,
            "high-water mark dropped"
        );
    }

    /// @dev Distributes fees and asserts the S3 fan-out: LI.FI's booked parts land on the
    ///      live recipient, the integrator's parts fan 60/40 across its two wallets (second
    ///      absorbs the remainder), and every fee counter is zeroed.
    function _distributeFeesAndAssertFanOut() internal {
        uint256 lifiAssets = wrapper.lifiFeeAssets();
        uint256 integratorAssets = wrapper.integratorFeeAssets();
        uint256 lifiShares = wrapper.lifiFeeShares();
        uint256 integratorShares = wrapper.integratorFeeShares();
        assertGt(lifiAssets + integratorAssets, 0, "no asset fees booked");
        assertGt(lifiShares + integratorShares, 0, "no dilution fees booked");

        wrapper.distributeFees();

        assertEq(wrapper.lifiFeeAssets(), 0);
        assertEq(wrapper.integratorFeeAssets(), 0);
        assertEq(wrapper.lifiFeeShares(), 0);
        assertEq(wrapper.integratorFeeShares(), 0);

        // Recipients started empty, so post-distribution balances equal the payouts outright.
        _assertFanOut(
            asset.balanceOf(lifiRecipient),
            asset.balanceOf(integrator1),
            asset.balanceOf(integrator2),
            lifiAssets,
            integratorAssets
        );
        _assertFanOut(
            wrapper.balanceOf(lifiRecipient),
            wrapper.balanceOf(integrator1),
            wrapper.balanceOf(integrator2),
            lifiShares,
            integratorShares
        );
    }

    /// @dev Asserts one reservoir token's payout: LI.FI gets its whole booked part, the two
    ///      integrator wallets split the integrator part 60/40 with the second wallet
    ///      absorbing the flooring remainder.
    function _assertFanOut(
        uint256 _lifiBal,
        uint256 _wallet1Bal,
        uint256 _wallet2Bal,
        uint256 _lifiPart,
        uint256 _integratorPart
    ) internal pure {
        uint256 wallet1 = (_integratorPart * RECEIVER_1_BPS) / 10_000;
        assertEq(_lifiBal, _lifiPart, "lifi payout mismatch");
        assertEq(_wallet1Bal, wallet1, "wallet1 payout mismatch");
        assertEq(
            _wallet2Bal,
            _integratorPart - wallet1,
            "wallet2 payout mismatch"
        );
    }

    /// @dev Disables fees so fee recipients can realize their swept shares without incurring
    ///      new fees, drains them, then asserts nothing is stranded and the system paid out
    ///      strictly more than was deposited (real yield flowed through).
    function _drainAndAssertConservation() internal {
        vm.startPrank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Performance, 0);
        wrapper.setFeeRate(FeeType.Management, 0);
        wrapper.setFeeRate(FeeType.Deposit, 0);
        wrapper.setFeeRate(FeeType.Withdrawal, 0);
        vm.stopPrank();

        _redeem(lifiRecipient, wrapper.balanceOf(lifiRecipient));
        _redeem(integrator1, wrapper.balanceOf(integrator1));
        _redeem(integrator2, wrapper.balanceOf(integrator2));

        assertEq(wrapper.totalSupply(), 0, "shares left outstanding");
        assertLe(wrapper.totalAssets(), DRAIN_DUST, "position not drained");
        assertLe(
            asset.balanceOf(address(wrapper)),
            DRAIN_DUST,
            "idle assets stranded"
        );

        uint256 sumFinal = asset.balanceOf(alice) +
            asset.balanceOf(bob) +
            asset.balanceOf(carol) +
            asset.balanceOf(lifiRecipient) +
            asset.balanceOf(integrator1) +
            asset.balanceOf(integrator2) +
            asset.balanceOf(address(wrapper)) +
            wrapper.totalAssets();

        assertGt(
            sumFinal,
            3 * FUNDING,
            "value destroyed or no yield distributed"
        );
    }
}
