// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { defaultReceivers } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";
import { VaultWrapperFeeTestBase } from "test/solidity/VaultWrapper/VaultWrapperFeeTestBase.sol";

/// @notice The wrapper's protection layer (EXSC-414): EIP-5143 slippage-guarded
///         entrypoints, the asset-derived virtual-share decimals offset, and the
///         minimum share-supply floor (first-depositor inflation mitigation).
contract LiFiVaultWrapperProtectionsTest is VaultWrapperFeeTestBase {
    uint256 internal constant MIN_SHARE_SUPPLY = 1e6;

    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");

    function setUp() public override {
        super.setUp();
        FeeConfig memory fees;
        wrapper = _newWrapper(fees);
    }

    /// EIP-5143 slippage guards ///

    function test_DepositWithMinSharesPassesAtQuote() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        uint256 quoted = wrapper.previewDeposit(DEPOSIT);
        uint256 shares = wrapper.deposit(DEPOSIT, alice, quoted);
        vm.stopPrank();

        assertEq(shares, quoted);
        assertEq(wrapper.balanceOf(alice), quoted);
    }

    function testRevert_DepositBelowMinShares() public {
        asset.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        asset.approve(address(wrapper), DEPOSIT);

        uint256 quoted = wrapper.previewDeposit(DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                quoted,
                quoted + 1
            )
        );

        wrapper.deposit(DEPOSIT, alice, quoted + 1);
        vm.stopPrank();
    }

    function test_MintWithMaxAssetsPassesAtQuote() public {
        uint256 quoted = wrapper.previewMint(DEPOSIT);
        asset.mint(alice, quoted);
        vm.startPrank(alice);
        asset.approve(address(wrapper), quoted);

        uint256 assetsIn = wrapper.mint(DEPOSIT, alice, quoted);
        vm.stopPrank();

        assertEq(assetsIn, quoted);
        assertEq(wrapper.balanceOf(alice), DEPOSIT);
    }

    function testRevert_MintAboveMaxAssets() public {
        uint256 quoted = wrapper.previewMint(DEPOSIT);
        asset.mint(alice, quoted);
        vm.startPrank(alice);
        asset.approve(address(wrapper), quoted);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                quoted,
                quoted - 1
            )
        );

        wrapper.mint(DEPOSIT, alice, quoted - 1);
        vm.stopPrank();
    }

    function test_WithdrawWithMaxSharesPassesAtQuote() public {
        _deposit(alice, DEPOSIT);
        uint256 half = DEPOSIT / 2;
        uint256 quoted = wrapper.previewWithdraw(half);

        vm.prank(alice);
        uint256 burned = wrapper.withdraw(half, alice, alice, quoted);

        assertEq(burned, quoted);
        assertEq(asset.balanceOf(alice), half);
    }

    function testRevert_WithdrawAboveMaxShares() public {
        _deposit(alice, DEPOSIT);
        uint256 half = DEPOSIT / 2;
        uint256 quoted = wrapper.previewWithdraw(half);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                quoted,
                quoted - 1
            )
        );

        wrapper.withdraw(half, alice, alice, quoted - 1);
    }

    function test_RedeemWithMinAssetsPassesAtQuote() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);
        uint256 quoted = wrapper.previewRedeem(shares);

        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(shares, alice, alice, quoted);

        assertEq(assetsOut, quoted);
    }

    function testRevert_RedeemBelowMinAssets() public {
        _deposit(alice, DEPOSIT);
        uint256 shares = wrapper.balanceOf(alice);
        uint256 quoted = wrapper.previewRedeem(shares);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                quoted,
                quoted + 1
            )
        );

        wrapper.redeem(shares, alice, alice, quoted + 1);
    }

    function testRevert_DepositSlippageGuardCatchesFeeRateFrontRun() public {
        // The quote-invalidating event the guard exists for: the integrator raises
        // the deposit fee between the caller's quote and execution.
        _stackWithFactory(FeeType.Deposit, 100, 2000); // 1% now, bounds allow 20%
        _deposit(alice, DEPOSIT); // seed so the fee change is the only variable

        uint256 quoted = wrapper.previewDeposit(DEPOSIT);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Deposit, 2000);

        uint256 repriced = wrapper.previewDeposit(DEPOSIT);
        assertLt(repriced, quoted);

        asset.mint(bob, DEPOSIT);
        vm.startPrank(bob);
        asset.approve(address(wrapper), DEPOSIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SlippageExceeded.selector,
                repriced,
                quoted
            )
        );

        wrapper.deposit(DEPOSIT, bob, quoted);
        vm.stopPrank();
    }

    /// Derived decimals offset ///

    function test_ShareDecimalsOffsetFlooredAtMinimum() public {
        // 18-decimal asset: derived offset is 0, floored at the 6 minimum, so shares
        // are 24 decimals (the minimum keeps high-decimal assets donation-resistant).
        assertEq(wrapper.shareDecimalsOffset(), 6);
        assertEq(wrapper.decimals(), 24);

        // 6-decimal asset: derived offset 12 already exceeds the minimum, so shares
        // stay normalized to 18 decimals.
        LiFiVaultWrapper wrapper6 = _newWrapper6Decimals();

        assertEq(wrapper6.shareDecimalsOffset(), 12);
        assertEq(wrapper6.decimals(), 18);
    }

    function testRevert_InitializeWithUnreadableAssetDecimals() public {
        // OZ's ERC-4626 init silently substitutes 18 when the asset's decimals() reverts
        // or returns an out-of-range value; sizing the virtual-share offset off that
        // fallback would quietly weaken inflation protection. Both malformed cases must
        // be rejected at initialization instead.
        bytes memory revertingInit = _initCallFor(
            address(new AssetOnlyVault(address(new RevertingDecimalsToken())))
        );

        vm.expectRevert(ILiFiVaultWrapper.AssetDecimalsUnavailable.selector);

        new BeaconProxy(address(beacon), revertingInit);

        bytes memory oversizedInit = _initCallFor(
            address(new AssetOnlyVault(address(new OversizedDecimalsToken())))
        );

        vm.expectRevert(ILiFiVaultWrapper.AssetDecimalsUnavailable.selector);

        new BeaconProxy(address(beacon), oversizedInit);
    }

    function test_DonationCannotBlockDepositLargerThanItself() public {
        // Regression for the dust-donation launch DoS: with the minimum offset the
        // asset barrier a donation imposes is at most 1x the donation, so a deposit
        // larger than the donation always clears the floor. At offset 0 this same
        // 1-token donation would have blocked every sub-1M-token first deposit.
        MockERC4626 source = MockERC4626(address(underlying));
        uint256 donated = 1e18; // 1 token
        asset.mint(attacker, donated);
        vm.startPrank(attacker);
        asset.approve(address(source), donated);
        uint256 ds = source.deposit(donated, attacker);
        source.transfer(address(wrapper), ds);
        vm.stopPrank();

        assertEq(wrapper.totalSupply(), 0);

        uint256 firstDeposit = 2 * donated;
        asset.mint(victim, firstDeposit);
        vm.startPrank(victim);
        asset.approve(address(wrapper), firstDeposit);
        uint256 shares = wrapper.deposit(firstDeposit, victim);
        vm.stopPrank();

        assertGe(shares, MIN_SHARE_SUPPLY);
        assertGe(wrapper.totalSupply(), MIN_SHARE_SUPPLY);
    }

    function test_InflationAttackIsUnprofitableOnLowDecimalAsset() public {
        LiFiVaultWrapper wrapper6 = _newWrapper6Decimals();
        MockERC20 usdc = MockERC20(wrapper6.asset());
        MockERC4626 source = MockERC4626(wrapper6.underlying());

        // Attacker front-runs the victim: a minimal wrapper deposit, then a donation
        // of 1M tokens' worth of source shares to inflate the wrapper's share price.
        uint256 seeded = 1; // 1 wei of the 6-decimal asset
        uint256 donated = 1_000_000e6;
        usdc.mint(attacker, seeded + donated);
        vm.startPrank(attacker);
        usdc.approve(address(wrapper6), seeded);
        uint256 attackerShares = wrapper6.deposit(seeded, attacker);
        usdc.approve(address(source), donated);
        uint256 donatedSourceShares = source.deposit(donated, attacker);
        source.transfer(address(wrapper6), donatedSourceShares);
        vm.stopPrank();

        // The victim's deposit is not zeroed out by the inflated share price...
        uint256 victimDeposit = 1_000e6;
        usdc.mint(victim, victimDeposit);
        vm.startPrank(victim);
        usdc.approve(address(wrapper6), victimDeposit);
        uint256 victimShares = wrapper6.deposit(victimDeposit, victim);
        vm.stopPrank();

        assertGt(victimShares, 0);

        // ...and the victim exits with at most dust-level rounding loss.
        vm.prank(victim);
        uint256 victimOut = wrapper6.redeem(victimShares, victim, victim);

        assertGe(victimOut, victimDeposit - 2);

        // The attacker recovers strictly less than what the attack cost: the virtual
        // shares absorb a pro-rata part of the donation, so griefing burns the
        // attacker's own capital without extracting the victim's.
        vm.prank(attacker);
        uint256 attackerOut = wrapper6.redeem(
            attackerShares,
            attacker,
            attacker
        );

        assertLt(attackerOut, seeded + donated);
    }

    /// Minimum share-supply floor ///

    function testRevert_ZeroShareDepositIntoDonatedEmptyVault() public {
        // Attacker donates source shares straight to the wrapper: totalAssets() > 0
        // while totalSupply() stays 0. The minimum offset (6) means the victim's deposit
        // only rounds to zero shares once the donation exceeds it by ~MIN_SHARE_SUPPLY,
        // so the donation dwarfs the deposit here (the grief is deeply unprofitable).
        MockERC4626 source = MockERC4626(address(underlying));
        uint256 donated = 2_000_000e18;
        asset.mint(attacker, donated);
        vm.startPrank(attacker);
        asset.approve(address(source), donated);
        uint256 donatedShares = source.deposit(donated, attacker);
        source.transfer(address(wrapper), donatedShares);
        vm.stopPrank();

        assertEq(wrapper.totalSupply(), 0);
        assertGt(wrapper.totalAssets(), 0);

        // The victim's deposit rounds to zero shares against the inflated price. Without
        // the zero-supply guard this would forward the assets for no shares (100% loss);
        // the floor must reject it.
        uint256 victimDeposit = 1e18;
        asset.mint(victim, victimDeposit);
        vm.startPrank(victim);
        asset.approve(address(wrapper), victimDeposit);
        assertEq(wrapper.previewDeposit(victimDeposit), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SupplyBelowMinimum.selector,
                0,
                MIN_SHARE_SUPPLY
            )
        );

        wrapper.deposit(victimDeposit, victim);
        vm.stopPrank();
    }

    function testRevert_MintBelowSupplyFloor() public {
        // Any nonzero deposit into a clean vault over-clears the floor (the offset
        // scales shares up by 10 ** offset), so the floor is reached from below only by
        // minting an explicit sub-floor share count.
        uint256 shares = MIN_SHARE_SUPPLY / 2;
        asset.mint(alice, 1);
        vm.startPrank(alice);
        asset.approve(address(wrapper), 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SupplyBelowMinimum.selector,
                shares,
                MIN_SHARE_SUPPLY
            )
        );

        wrapper.mint(shares, alice);
        vm.stopPrank();
    }

    function test_FirstDepositAtSupplyFloorPasses() public {
        // The smallest possible deposit (1 asset-wei) already mints exactly the floor,
        // since the offset scales 1 wei into MIN_SHARE_SUPPLY shares.
        _deposit(alice, 1);

        assertEq(wrapper.totalSupply(), MIN_SHARE_SUPPLY);
    }

    function test_ExitMayStrandDustSupplyButNextDepositMustClearFloor()
        public
    {
        // Exits are exempt from the floor (they must always work), so a sub-floor
        // supply can be stranded...
        _deposit(alice, 2 * MIN_SHARE_SUPPLY);
        uint256 leftBehind = MIN_SHARE_SUPPLY / 2;
        uint256 toRedeem = wrapper.balanceOf(alice) - leftBehind;

        vm.prank(alice);
        wrapper.redeem(toRedeem, alice, alice);

        assertEq(wrapper.totalSupply(), leftBehind);

        // ...but anyone entering that state is still protected: an operation leaving the
        // supply below the floor reverts. A plain deposit over-clears the floor (the
        // offset scales shares up), so the sub-floor top-up is shown via an explicit
        // mint of fewer shares than the floor needs.
        uint256 shortMint = MIN_SHARE_SUPPLY / 4;
        asset.mint(bob, 1);
        vm.startPrank(bob);
        asset.approve(address(wrapper), 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.SupplyBelowMinimum.selector,
                leftBehind + shortMint,
                MIN_SHARE_SUPPLY
            )
        );

        wrapper.mint(shortMint, bob);
        vm.stopPrank();

        _deposit(bob, MIN_SHARE_SUPPLY);

        assertGe(wrapper.totalSupply(), MIN_SHARE_SUPPLY);
    }

    function test_ZeroDepositAndMintAreNoopsRegardlessOfSupply() public {
        // A zero-amount deposit/mint moves nothing and mints nothing, so it must never
        // revert on the supply floor — not on a fresh empty vault, nor in a sub-floor
        // state an exit can strand. The floor guards real deposits, not zero-amount
        // accrual pokes.
        vm.startPrank(bob);

        assertEq(wrapper.deposit(0, bob), 0);
        assertEq(wrapper.mint(0, bob), 0);
        vm.stopPrank();

        assertEq(wrapper.totalSupply(), 0);

        _deposit(alice, 2 * MIN_SHARE_SUPPLY);
        uint256 leftBehind = MIN_SHARE_SUPPLY / 2;
        uint256 toRedeem = wrapper.balanceOf(alice) - leftBehind;

        vm.prank(alice);
        wrapper.redeem(toRedeem, alice, alice);

        assertEq(wrapper.totalSupply(), leftBehind);

        vm.startPrank(bob);

        assertEq(wrapper.deposit(0, bob), 0);
        assertEq(wrapper.mint(0, bob), 0);
        vm.stopPrank();

        assertEq(wrapper.totalSupply(), leftBehind);
        assertEq(wrapper.balanceOf(bob), 0);
    }

    function test_FullExitSucceedsWithFeeShareResidue() public {
        // Regression: fee accrual mints shares to the wrapper itself, so the last
        // holder's full exit leaves those fee shares as the only supply. The exit must
        // still succeed — exits never consult the floor. (Sub-floor exit-exemption is
        // covered by test_ExitMayStrand... and test_FullExitToZeroSupplyPasses.)
        FeeConfig memory fees;
        fees.rateBps[uint8(FeeType.Management)] = MGMT_RATE;
        wrapper = _newWrapper(fees);
        _deposit(alice, 2 * MIN_SHARE_SUPPLY);

        vm.warp(block.timestamp + 30 days);
        uint256 aliceShares = wrapper.balanceOf(alice);

        vm.prank(alice);
        wrapper.redeem(aliceShares, alice, alice);

        uint256 residue = wrapper.totalSupply();
        assertEq(wrapper.balanceOf(alice), 0);
        assertGt(residue, 0);
        assertEq(wrapper.balanceOf(address(wrapper)), residue);
    }

    function test_ExitLeavingFloorSupplyPasses() public {
        _deposit(alice, 2 * MIN_SHARE_SUPPLY);
        uint256 toRedeem = wrapper.balanceOf(alice) - MIN_SHARE_SUPPLY;

        vm.prank(alice);
        wrapper.redeem(toRedeem, alice, alice);

        assertEq(wrapper.totalSupply(), MIN_SHARE_SUPPLY);
    }

    function test_FullExitToZeroSupplyPasses() public {
        _deposit(alice, 2 * MIN_SHARE_SUPPLY);
        uint256 allShares = wrapper.balanceOf(alice);

        vm.prank(alice);
        wrapper.redeem(allShares, alice, alice);

        assertEq(wrapper.totalSupply(), 0);
    }

    /// Helpers ///

    function _newWrapper6Decimals() internal returns (LiFiVaultWrapper w) {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC4626 source = new MockERC4626(usdc, "Yield USDC", "yUSDC");
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(source),
                address(adapter),
                vaultAdmin,
                [SPLIT, SPLIT, SPLIT, SPLIT],
                fees,
                defaultReceivers(),
                address(0)
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _initCallFor(
        address _underlying
    ) internal view returns (bytes memory) {
        FeeConfig memory fees;

        return
            abi.encodeCall(
                LiFiVaultWrapper.initialize,
                (
                    _underlying,
                    address(adapter),
                    vaultAdmin,
                    [SPLIT, SPLIT, SPLIT, SPLIT],
                    fees,
                    defaultReceivers(),
                    address(0)
                )
            );
    }
}

/// @dev Asset stub whose decimals() reverts, forcing OZ's ERC-4626 init onto its 18
///      fallback.
contract RevertingDecimalsToken {
    error NoDecimals();

    function decimals() external pure returns (uint8) {
        revert NoDecimals();
    }
}

/// @dev Asset stub whose decimals() returns an out-of-range value, which OZ treats as a
///      failed read and replaces with 18.
contract OversizedDecimalsToken {
    function decimals() external pure returns (uint256) {
        return 300;
    }
}

/// @dev Minimal ERC-4626-shaped underlying exposing only asset(), so the wrapper resolves
///      the malformed token without the source vault reading its decimals at construction.
contract AssetOnlyVault {
    address private immutable ASSET;

    constructor(address _asset) {
        ASSET = _asset;
    }

    function asset() external view returns (address) {
        return ASSET;
    }
}
