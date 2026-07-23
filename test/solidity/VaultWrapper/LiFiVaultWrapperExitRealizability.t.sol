// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";
import { MockCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockCappedERC4626.sol";
import { MockLossyERC4626 } from "test/solidity/VaultWrapper/mocks/MockLossyERC4626.sol";
import { MockLossyCappedERC4626 } from "test/solidity/VaultWrapper/mocks/MockLossyCappedERC4626.sol";
import { MockShortPayingERC4626 } from "test/solidity/VaultWrapper/mocks/MockShortPayingERC4626.sol";

/// @notice Exit realizability and source-limit awareness (review findings #3/#4):
///         loss-tolerant redeem, cost-aware exact-out withdraw, and max*/preview views
///         that consult the underlying's own caps, liquidity, and realizable values.
contract LiFiVaultWrapperExitRealizabilityTest is VaultWrapperFeeTestBase {
    uint16 internal constant DEPOSIT_FEE = 100; // 1%
    uint16 internal constant WITHDRAW_FEE = 50; // 0.5%

    MockCappedERC4626 internal capped;

    function setUp() public override {
        super.setUp();
        FeeConfig memory fees;
        wrapper = _newWrapper(fees);
        capped = new MockCappedERC4626(asset);
    }

    /// Deposit-side limits (finding #4) ///

    function test_MaxDepositReflectsSourceCap() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        assertEq(w.maxDeposit(alice), 500e18);
    }

    function test_MaxDepositGrossesUpForDepositFee() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Deposit)] = DEPOSIT_FEE;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        uint256 max = w.maxDeposit(alice);

        // The fee is skimmed before forwarding, so the user-facing max is the cap
        // grossed up by the deposit fee: 500e18 + ceil(500e18 * 1%) = 505e18.
        assertEq(max, 505e18);

        // Tightness from above: one wei over `max` is rejected by the wrapper's own
        // `maxDeposit` guard in OZ's `deposit` entrypoint — it never even reaches the
        // source's cap check.
        asset.mint(bob, max + 1);
        vm.startPrank(bob);
        asset.approve(address(w), max + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626Upgradeable.ERC4626ExceededMaxDeposit.selector,
                bob,
                max + 1,
                max
            )
        );
        w.deposit(max + 1, bob);
        vm.stopPrank();

        // Depositing exactly `max` must succeed.
        asset.mint(alice, max);
        vm.startPrank(alice);
        asset.approve(address(w), max);
        w.deposit(max, alice);
        vm.stopPrank();
    }

    function test_MaxDepositUnlimitedWhenSourceUncapped() public view {
        assertEq(wrapper.maxDeposit(alice), type(uint256).max);
    }

    function test_MaxDepositZeroWhenSourceLimitViewReverts() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setRevertOnLimitViews(true);

        assertEq(w.maxDeposit(alice), 0);
        assertEq(w.maxMint(alice), 0);
    }

    function test_MaxMintConvertsCappedMaxDeposit() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(500e18);

        uint256 maxShares = w.maxMint(alice);

        assertEq(maxShares, w.previewDeposit(w.maxDeposit(alice)));
        // Minting the advertised max must succeed.
        uint256 assetsNeeded = w.previewMint(maxShares);
        asset.mint(alice, assetsNeeded);
        vm.startPrank(alice);
        asset.approve(address(w), assetsNeeded);
        w.mint(maxShares, alice);
        vm.stopPrank();
    }

    function test_MaxMintUnlimitedWhenSourceUncapped() public view {
        assertEq(wrapper.maxMint(alice), type(uint256).max);
    }

    function test_MaxDepositZeroWhenSourceCapZero() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Deposit)] = DEPOSIT_FEE;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(0);

        assertEq(w.maxDeposit(alice), 0);
        assertEq(w.maxMint(alice), 0);
    }

    function test_MaxDepositTinyCapAtMaxFeeIsExecutable() public {
        // cap = 1 wei at the 20% bytecode-cap fee: the strongest ceil-rounding corner.
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Deposit)] = 2000;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(1);

        uint256 max = w.maxDeposit(alice);

        assertEq(max, 2); // 1 + ceil(1 * 2000 / 10000) = 2
        asset.mint(alice, max);
        vm.startPrank(alice);
        asset.approve(address(w), max);
        w.deposit(max, alice);
        vm.stopPrank();
    }

    function test_MaxDepositSaturatesNearUintMaxCap() public {
        // A finite cap large enough that the fee gross-up would wrap must saturate
        // to the unlimited sentinel instead of overflowing.
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Deposit)] = DEPOSIT_FEE;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(type(uint256).max - 1);

        assertEq(w.maxDeposit(alice), type(uint256).max);
    }

    function test_MaxDepositStillZeroWhenPaused() public {
        vm.prank(vaultAdmin);
        wrapper.pause();

        assertEq(wrapper.maxDeposit(alice), 0);
        assertEq(wrapper.maxMint(alice), 0);
    }

    /// Loss-tolerant redeem (finding #3) ///

    function test_RedeemSurvivesSourceTurningLossy() public {
        // The bricking scenario from the finding: the underlying adds an exit fee
        // AFTER deposits are in. Old behavior: AdapterWithdrawShortfall forever.
        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100); // 1% exit fee
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);
        uint256 quoted = w.previewRedeem(shares);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // The haircut lands on the exiting user, exits keep working, and the
        // preview told the truth about it.
        assertEq(paid, quoted);
        assertEq(asset.balanceOf(alice), paid);
        assertApproxEqAbs(paid, (DEPOSIT * 99) / 100, 2);
    }

    function test_RedeemPassesShortfallThroughOnShortPayingSource() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 short = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(short),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // Previews cannot see a lying source, but the exit still works and only
        // the exiter absorbs the withheld wei.
        assertApproxEqAbs(paid, DEPOSIT - short.SHORTFALL(), 2);
        assertEq(asset.balanceOf(alice), paid);
    }

    function test_RedeemSlippageOverloadGuardsLossyProceeds() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 short = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(short),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 shares = w.balanceOf(alice);
        uint256 quoted = w.previewRedeem(shares); // over-promises by SHORTFALL

        // The mock is 1:1 with no yield/loss, so the wrapper's own valuation is exact
        // (no virtual-share rounding here); the only shortfall is the source's SHORTFALL.
        uint256 expectedActual = quoted - short.SHORTFALL();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                expectedActual,
                quoted
            )
        );

        w.redeem(shares, alice, alice, quoted);
    }

    function test_RedeemReturnValueAndEventCarryActualProceeds() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);
        uint256 quoted = wrapper.previewRedeem(shares);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(wrapper));
        emit Withdraw(alice, alice, alice, quoted, shares);
        uint256 paid = wrapper.redeem(shares, alice, alice);

        assertEq(paid, quoted);
    }

    function test_RedeemChargesWithdrawalFeeOnActualProceeds() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        wrapper = w; // point the base-class fee counters helper at this instance

        uint256 shares = w.balanceOf(alice);
        uint256 quoted = w.previewRedeem(shares);

        vm.prank(alice);
        uint256 paid = w.redeem(shares, alice, alice);

        // Pre-redeem quote parity: previewRedeem computes the fee on the realizable
        // (post-loss) amount, so this only holds if execution uses the same basis —
        // a buggy fee-on-gross implementation would diverge here by ~1% of the fee.
        assertEq(paid, quoted);

        // Fee basis is what the source actually paid, not the pre-loss valuation:
        // fee + payout == actual proceeds, and the fee is feeOnTotal(actual).
        uint256 actual = paid + _accruedFeeAssets();
        assertApproxEqAbs(actual, (DEPOSIT * 99) / 100, 2);
        assertEq(asset.balanceOf(address(w)), _accruedFeeAssets());
        // Exact fee pin: feeOnTotal(actual) = ceil(actual * rate / (10_000 + rate)).
        assertEq(
            _accruedFeeAssets(),
            Math.mulDiv(
                actual,
                WITHDRAW_FEE,
                uint256(WITHDRAW_FEE) + 10_000,
                Math.Rounding.Ceil
            )
        );
    }

    function test_RedeemAllowanceStillEnforced() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                bob,
                0,
                shares
            )
        );
        wrapper.redeem(shares, bob, alice);

        vm.prank(alice);
        wrapper.approve(bob, shares);

        vm.prank(bob);
        uint256 paid = wrapper.redeem(shares, bob, alice);

        assertEq(asset.balanceOf(bob), paid);
        assertEq(wrapper.balanceOf(alice), 0);
    }

    function test_SoleHolderFullRedeemLeavesNoResidualPosition() public {
        _deposit(alice, DEPOSIT);
        _simulateYield(333); // odd wei so the PPS is fractional and floors bite
        uint256 shares = wrapper.balanceOf(alice);
        uint256 quoted = wrapper.previewRedeem(shares);

        vm.prank(alice);
        uint256 paid = wrapper.redeem(shares, alice, alice);

        assertEq(paid, quoted); // drain is mirrored in the preview
        assertEq(wrapper.totalSupply(), 0);
        assertEq(wrapper.totalAssets(), 0); // no valueful residue behind an empty vault
        assertEq(underlying.balanceOf(address(wrapper)), 0);
    }

    /// Cost-aware exact-out withdraw (no socialization) ///

    function test_WithdrawDoesNotSocializeSourceExitFee() public {
        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100); // 1% exit fee
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        _depositTo(w, bob, DEPOSIT);

        uint256 bobQuoteBefore = w.previewRedeem(w.balanceOf(bob));
        uint256 half = DEPOSIT / 2;

        vm.prank(alice);
        uint256 burned = w.withdraw(half, alice, alice);

        // Alice received exactly `half`, and her shares — not Bob's value — paid the
        // source's 1% exit fee: her burn is ~1% more than the no-fee burn would be.
        assertEq(asset.balanceOf(alice), half);
        assertGt(burned, w.previewDeposit(half));
        // Bob's redeemable value is untouched (±2 wei rounding dust — the plan's
        // original ±1 undercounts the double floor/ceil rounding through
        // convertToAssets + previewWithdrawUpTo; do not silently widen this further
        // without re-checking why a wider drift crept in).
        assertApproxEqAbs(
            w.previewRedeem(w.balanceOf(bob)),
            bobQuoteBefore,
            2
        );
    }

    function test_PreviewWithdrawMatchesExecutionBurnOnLossySource() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 half = DEPOSIT / 2;
        uint256 quotedShares = w.previewWithdraw(half);

        vm.prank(alice);
        uint256 burned = w.withdraw(half, alice, alice);

        assertEq(burned, quotedShares);
        assertEq(asset.balanceOf(alice), half);
    }

    function test_WithdrawStaysStrictOnShortPayingSource() public {
        FeeConfig memory fees;
        MockShortPayingERC4626 shortSource = new MockShortPayingERC4626(asset);
        LiFiVaultWrapper w = _newWrapperFor(
            address(shortSource),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 half = DEPOSIT / 2;
        // Read before `vm.prank`: `SHORTFALL()` is itself an external call, and reading it
        // as part of building the `expectRevert` calldata would otherwise consume the
        // single-shot prank meant for `withdraw` below.
        uint256 shortfall = shortSource.SHORTFALL();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.AdapterWithdrawShortfall.selector,
                half,
                half - shortfall
            )
        );

        w.withdraw(half, alice, alice);
    }

    /// Liquidity-aware exit limits ///

    function test_MaxWithdrawReflectsSourceLiquidity() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setLiquidity(100e18);

        uint256 max = w.maxWithdraw(alice);

        assertLe(max, 100e18);
        vm.prank(alice);
        w.withdraw(max, alice, alice); // must not revert

        // One wei above the advertised max must revert (over-report check).
        vm.prank(alice);
        vm.expectRevert();
        w.withdraw(max + 1, alice, alice);
    }

    function test_MaxRedeemReflectsSourceLiquidity() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setLiquidity(100e18);

        uint256 maxShares = w.maxRedeem(alice);

        assertLt(maxShares, w.balanceOf(alice));
        vm.prank(alice);
        w.redeem(maxShares, alice, alice); // must not revert
    }

    function test_MaxExitViewsUnchangedOnUncappedSource() public {
        _deposit(alice, DEPOSIT);

        assertEq(wrapper.maxRedeem(alice), wrapper.balanceOf(alice));
        // Strict-path capacity: fee-net floor valuation (drain-free by design).
        uint256 gross = wrapper.convertToAssets(wrapper.balanceOf(alice));
        assertEq(wrapper.maxWithdraw(alice), gross);
    }

    function test_MaxExitViewsFailSoftWhenSourceLimitViewReverts() public {
        FeeConfig memory fees;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setRevertOnLimitViews(true);

        // Fail-soft: liquidity reads as 0, so exits report closed instead of the
        // views reverting (EIP-4626 max* MUST NOT revert).
        assertEq(w.maxWithdraw(alice), 0);
        assertEq(w.maxRedeem(alice), 0);
    }

    function test_WithdrawMaxWithdrawNeverOverBurnsOnLossySource() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);

        uint256 max = w.maxWithdraw(alice);

        vm.prank(alice);
        w.withdraw(max, alice, alice); // must not revert
    }

    /// Forward-verified off-fee-grid regressions (quality review findings) ///

    function test_WithdrawMaxWithdrawSucceedsOffFeeGridOnLossySource() public {
        FeeConfig memory noFees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            noFees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        // Ragged, off-the-1%-fee-grid deposit amounts (the reviewer's exact repro):
        // an algebraic (non-forward-verified) candidate rounds 1 share-wei over.
        _depositTo(w, alice, DEPOSIT + 1);
        _depositTo(w, bob, DEPOSIT + 1);

        uint256 max = w.maxWithdraw(alice);

        vm.prank(alice);
        w.withdraw(max, alice, alice); // must not revert

        FeeConfig memory withdrawFee;
        withdrawFee.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        MockLossyERC4626 lossyWithFee = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper wWithFee = _newWrapperFor(
            address(lossyWithFee),
            withdrawFee,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(wWithFee, alice, DEPOSIT + 1);
        _depositTo(wWithFee, bob, DEPOSIT + 1);

        uint256 maxWithFee = wWithFee.maxWithdraw(alice);

        vm.prank(alice);
        wWithFee.withdraw(maxWithFee, alice, alice); // must not revert
    }

    function test_SoleHolderFullRedeemSucceedsOffFeeGridOnLossySource()
        public
    {
        FeeConfig memory noFees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, 100);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            noFees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT + 1);

        uint256 balance = w.balanceOf(alice);

        assertEq(w.maxRedeem(alice), balance);

        vm.prank(alice);
        w.redeem(balance, alice, alice); // must not revert

        assertEq(w.totalAssets(), 0);
        assertEq(w.totalSupply(), 0);
    }

    function test_MaxWithdrawLiquidityCapWithWithdrawalFee() public {
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = WITHDRAW_FEE;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT);
        capped.setLiquidity(100e18);

        uint256 max = w.maxWithdraw(alice);

        vm.prank(alice);
        w.withdraw(max, alice, alice); // must not revert
    }

    function test_ExitLimitsOnLossyAndCappedSource() public {
        FeeConfig memory noFees;
        MockLossyCappedERC4626 lossyCapped = new MockLossyCappedERC4626(
            asset,
            100
        );
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossyCapped),
            noFees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, DEPOSIT + 1);
        lossyCapped.setLiquidity(100e18 + 7);

        uint256 maxAssets = w.maxWithdraw(alice);
        vm.prank(alice);
        w.withdraw(maxAssets, alice, alice); // must not revert

        uint256 maxShares = w.maxRedeem(alice);
        vm.prank(alice);
        w.redeem(maxShares, alice, alice); // must not revert
    }

    /// Conformance fuzz ///

    /// @dev Invariant 5: advertised maxima never over-report across cap/liquidity/fee
    ///      combinations on an honest capped source — executing every advertised max
    ///      never reverts.
    function testFuzz_AdvertisedMaximaNeverRevert(
        uint256 _depositCap,
        uint256 _liquidity,
        uint256 _seedAmount,
        uint16 _withdrawFeeBps
    ) public {
        _depositCap = bound(_depositCap, 1e6, 1_000_000e18);
        _liquidity = bound(_liquidity, 1e6, 1_000_000e18);
        _seedAmount = bound(_seedAmount, 1e6, _depositCap);
        _withdrawFeeBps = uint16(bound(_withdrawFeeBps, 0, 500));

        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = _withdrawFeeBps;
        LiFiVaultWrapper w = _newWrapperFor(
            address(capped),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        capped.setDepositCap(_depositCap);
        _depositTo(w, alice, _seedAmount);
        capped.setLiquidity(_liquidity);

        uint256 maxDep = w.maxDeposit(bob);
        if (maxDep != 0 && maxDep != type(uint256).max) {
            uint256 amount = maxDep > 1_000_000e18 ? 1_000_000e18 : maxDep;
            asset.mint(bob, amount);
            vm.startPrank(bob);
            asset.approve(address(w), amount);
            w.deposit(amount, bob);
            vm.stopPrank();
        }

        uint256 maxW = w.maxWithdraw(alice);
        if (maxW != 0) {
            vm.prank(alice);
            w.withdraw(maxW, alice, alice);
        }
        uint256 maxR = w.maxRedeem(alice);
        if (maxR != 0) {
            vm.prank(alice);
            w.redeem(maxR, alice, alice);
        }
    }

    /// @dev Invariant 3: preview == execution in the same block on a lossy-but-honest
    ///      source, for both exit entrypoints, at ragged amounts and fees.
    function testFuzz_PreviewsMatchExecutionOnLossySource(
        uint256 _amount,
        uint256 _exitPart,
        uint16 _sourceFeeBps,
        uint16 _withdrawFeeBps
    ) public {
        _amount = bound(_amount, 1e12, 1_000_000e18);
        _sourceFeeBps = uint16(bound(_sourceFeeBps, 0, 1000));
        _withdrawFeeBps = uint16(bound(_withdrawFeeBps, 0, 500));

        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = _withdrawFeeBps;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, _sourceFeeBps);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, _amount);

        // redeem: returned assets equal the preview exactly.
        uint256 shares = w.balanceOf(alice);
        uint256 sharePart = bound(_exitPart, 1, shares);
        uint256 quotedAssets = w.previewRedeem(sharePart);

        vm.prank(alice);
        uint256 paid = w.redeem(sharePart, alice, alice);

        assertEq(paid, quotedAssets, "redeem != previewRedeem");

        // withdraw: burned shares equal the preview exactly.
        uint256 maxW = w.maxWithdraw(alice);
        if (maxW == 0) return;
        uint256 assetsOut = bound(_exitPart, 1, maxW);
        uint256 quotedShares = w.previewWithdraw(assetsOut);

        vm.prank(alice);
        uint256 burned = w.withdraw(assetsOut, alice, alice);

        assertEq(burned, quotedShares, "withdraw != previewWithdraw");
        assertEq(asset.balanceOf(alice), paid + assetsOut);
    }

    /// @dev Invariant 4: an exiting user cannot dilute remaining holders through
    ///      either exit path on a lossy source.
    function testFuzz_ExitsNeverDiluteRemainingHolders(
        uint256 _amount,
        uint256 _exitPart,
        uint16 _sourceFeeBps
    ) public {
        _amount = bound(_amount, 1e12, 1_000_000e18);
        _sourceFeeBps = uint16(bound(_sourceFeeBps, 0, 1000));

        FeeConfig memory fees;
        MockLossyERC4626 lossy = new MockLossyERC4626(asset, _sourceFeeBps);
        LiFiVaultWrapper w = _newWrapperFor(
            address(lossy),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, _amount);
        _depositTo(w, bob, _amount);

        uint256 bobBefore = w.previewRedeem(w.balanceOf(bob));

        // withdraw leg
        uint256 maxW = w.maxWithdraw(alice);
        if (maxW != 0) {
            uint256 assetsOut = bound(_exitPart, 1, maxW);
            vm.prank(alice);
            w.withdraw(assetsOut, alice, alice);
        }

        // redeem leg (whatever alice has left)
        uint256 aliceShares = w.balanceOf(alice);
        if (aliceShares != 0) {
            uint256 sharePart = bound(_exitPart, 1, aliceShares);
            vm.prank(alice);
            w.redeem(sharePart, alice, alice);
        }

        // Bob's realizable value never drops by more than rounding dust.
        assertGe(w.previewRedeem(w.balanceOf(bob)) + 2, bobBefore);
    }

    /// @dev Invariants 1+5 on a source that is BOTH lossy and liquidity-capped, at
    ///      ragged amounts: the advertised maxima stay executable and exits never brick.
    function testFuzz_ExitLimitsExecutableOnLossyCappedSource(
        uint256 _amount,
        uint256 _liquidity,
        uint16 _sourceFeeBps,
        uint16 _withdrawFeeBps
    ) public {
        _amount = bound(_amount, 1e12, 1_000_000e18);
        _liquidity = bound(_liquidity, 1e6, 1_000_000e18);
        _sourceFeeBps = uint16(bound(_sourceFeeBps, 0, 1000));
        _withdrawFeeBps = uint16(bound(_withdrawFeeBps, 0, 500));

        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Withdrawal)] = _withdrawFeeBps;
        MockLossyCappedERC4626 source = new MockLossyCappedERC4626(
            asset,
            _sourceFeeBps
        );
        LiFiVaultWrapper w = _newWrapperFor(
            address(source),
            fees,
            [SPLIT, SPLIT, SPLIT, SPLIT]
        );
        _depositTo(w, alice, _amount);
        source.setLiquidity(_liquidity);

        uint256 maxW = w.maxWithdraw(alice);
        if (maxW != 0) {
            vm.prank(alice);
            w.withdraw(maxW, alice, alice);
        }

        uint256 maxR = w.maxRedeem(alice);
        if (maxR != 0) {
            vm.prank(alice);
            w.redeem(maxR, alice, alice);
        }
    }

    /// Helpers ///

    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    function _depositTo(
        LiFiVaultWrapper _w,
        address _from,
        uint256 _amount
    ) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(_w), _amount);
        _w.deposit(_amount, _from);
        vm.stopPrank();
    }
}
