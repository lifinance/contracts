// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig, DeployParams, IntegratorReceivers } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Integration tests for the LiFiVaultWrapper fee engine (EXSC-410): management
///         dilution accrual, the preview==execution invariant, asset-side deposit/withdrawal
///         fees (Convention B), and the `setFeeRate` admin path. Mirrors the direct
///         beacon-proxy setup of `LiFiVaultWrapper.t.sol` (real inflatable `MockERC4626`),
///         and stands up the full factory stack only where live `feeBounds` are needed.
contract LiFiVaultWrapperFeesTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant MGMT_RATE = 200; // 2% / year
    uint16 internal constant DEP_RATE = 100; // 1%
    uint16 internal constant WD_RATE = 100; // 1%
    uint256 internal constant YEAR = 365 days;

    event FeeConfigUpdated(
        FeeType indexed feeType,
        uint16 newRateBps,
        bool enabled
    );

    event DilutionFeeAccrued(FeeType indexed feeType, uint256 feeShares);

    event AssetFeeCharged(FeeType indexed feeType, uint256 feeAssets);

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
    }

    /// Management fee accrual ///

    function test_ManagementFeeAccruesProRataOverTime() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        _deposit(alice, DEPOSIT);

        assertEq(wrapper.accruedFeeShares(), 0);

        vm.warp(block.timestamp + YEAR);

        (uint256 expectedShares, uint256 expectedAssets) = _expectedMgmt(
            wrapper
        );
        assertGt(expectedShares, 0);

        // A real operation crystallizes pending fees via _beforeOperation -> _accrueFees
        // before its own shares are minted, so the fee bookkeeping is exact regardless of
        // the triggering deposit's size.
        _crystallize();

        assertEq(wrapper.accruedFeeShares(), expectedShares);
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
        assertEq(wrapper.accruedFeeShares(), 0);
    }

    function test_DisabledManagementFeeDoesNotAccrue() public {
        wrapper = _newWrapperMgmtOnly(0); // disabled
        _deposit(alice, DEPOSIT);

        uint256 wrapperSharesBefore = wrapper.balanceOf(address(wrapper));

        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertEq(wrapper.balanceOf(address(wrapper)), wrapperSharesBefore);
        assertEq(wrapper.accruedFeeShares(), 0);
    }

    function test_ManagementFeeNoAccrualOnEmptyVault() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);

        // No prior deposits: totalSupply()/totalAssets() are zero, so the accrual at the
        // top of the first operation finds nothing to dilute.
        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertEq(wrapper.accruedFeeShares(), 0);
    }

    function test_SubThresholdElapsedTimeIsPreserved() public {
        wrapper = _newWrapperMgmtOnly(MGMT_RATE);
        // A tiny AUM makes the per-second management fee floor to zero shares, so the
        // accrual at the top of an operation finds nothing to mint.
        _deposit(alice, 1000);
        uint64 anchorBefore = wrapper.lastMgmtAccrual();

        vm.warp(block.timestamp + 1);
        _crystallize();
        assertEq(wrapper.accruedFeeShares(), 0);
        // lastMgmtAccrual does NOT advance while sub-threshold, so the elapsed second is
        // not silently discarded — it is still owed at the next accrual.
        assertEq(wrapper.lastMgmtAccrual(), anchorBefore);

        // Once enough AUM and time accumulate, the carried-over time accrues.
        _deposit(bob, DEPOSIT);
        vm.warp(block.timestamp + YEAR);
        _crystallize();

        assertGt(wrapper.accruedFeeShares(), 0);
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

        bytes32 sig = keccak256("DilutionFeeAccrued(uint8,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            assertEq(logs[i].emitter, address(wrapper));
            assertEq(
                uint256(logs[i].topics[1]),
                uint256(uint8(FeeType.Management))
            );
            uint256 shares = abi.decode(logs[i].data, (uint256));
            assertEq(shares, expectedShares);
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
        uint256 feeAssetsBefore = wrapper.accruedFeeAssets();
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
        assertEq(wrapper.accruedFeeAssets(), feeAssetsBefore + expectedFee);
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
        assertEq(wrapper.accruedFeeAssets(), expectedFee);
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
        emit AssetFeeCharged(FeeType.Deposit, expectedFee);

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
        emit AssetFeeCharged(FeeType.Withdrawal, expectedFee);

        wrapper.withdraw(amount, alice, alice);
    }

    function test_PreviewDepositMatchesExecutionOnSubFeeDust() public {
        // At a 1% deposit fee, feeOnTotal(1) = ceil(1*100/10100) = 1, so the net invested
        // amount rounds to 0. previewDeposit(1) returns 0; deposit(1) must not revert (the
        // wrapper skips the zero forward the underlying would reject) and must mint the same.
        wrapper = _newWrapperAssetFees(DEP_RATE, 0);
        _deposit(alice, DEPOSIT);

        uint256 feeBefore = wrapper.accruedFeeAssets();
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
        assertEq(wrapper.accruedFeeAssets(), feeBefore + dust);
        assertEq(asset.balanceOf(address(wrapper)), idleBefore + dust);
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
        assertEq(wrapper.accruedFeeShares(), 0);
        assertEq(wrapper.accruedFeeAssets(), 0);
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

    function testRevert_SetFeeRatePerformanceRejected() public {
        _stackWithFactory(MGMT_RATE);

        vm.prank(vaultAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.FeeTypeNotConfigurable.selector,
                FeeType.Performance
            )
        );
        wrapper.setFeeRate(FeeType.Performance, 100);
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

        assertEq(wrapper.accruedFeeShares(), expectedShares);
        assertEq(wrapper.lastMgmtAccrual(), block.timestamp);
    }

    /// Helpers ///

    LiFiVaultWrapperFactory internal factory;
    address internal owner = makeAddr("owner");

    function _newWrapper(
        FeeConfig memory _fees
    ) internal returns (LiFiVaultWrapper w) {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                8000,
                _fees,
                "",
                _sweepReceivers()
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _sweepReceivers()
        internal
        pure
        returns (IntegratorReceivers memory r)
    {
        address[] memory wallets = new address[](1);
        wallets[0] = address(0xFEE1);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        r = IntegratorReceivers({ wallets: wallets, bps: bps });
    }

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
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            makeAddr("pauser"),
            makeAddr("onboarder"),
            makeAddr("lifiRecipient")
        );

        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        factory.setFeeBounds(FeeType.Management, 0, 1000);
        vm.stopPrank();

        uint16[4] memory rates = [uint16(0), _mgmtRate, 0, 0];
        bool[4] memory enabled = [false, _mgmtRate != 0, false, false];
        address[] memory wallets = new address[](1);
        wallets[0] = address(0xFEE1);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        DeployParams memory p = DeployParams({
            namespace: bytes32("Coinbase"),
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: 0,
            fees: FeeConfig({ rateBps: rates, enabled: enabled }),
            integratorShareBps: type(uint16).max,
            initData: "",
            receivers: IntegratorReceivers({ wallets: wallets, bps: bps })
        });

        vm.prank(makeAddr("onboarder"));
        wrapper = LiFiVaultWrapper(factory.deploy(p));
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

    function _deposit(address _from, uint256 _amount) internal {
        asset.mint(_from, _amount);
        vm.startPrank(_from);
        asset.approve(address(wrapper), _amount);
        wrapper.deposit(_amount, _from);
        vm.stopPrank();
    }

    function _simulateYield(uint256 _amount) internal {
        asset.mint(address(underlying), _amount);
    }

    /// @dev Triggers `_beforeOperation -> _accrueFees` without depending on a zero-asset
    ///      deposit (solmate's MockERC4626 reverts ZERO_SHARES on a 0 forward). A 1-wei
    ///      deposit crystallizes pending management fees; the dust is negligible for the
    ///      assertions and is netted out where exact accounting is checked.
    function _crystallize() internal {
        asset.mint(address(this), 1);
        asset.approve(address(wrapper), 1);
        wrapper.deposit(1, address(this));
    }
}
