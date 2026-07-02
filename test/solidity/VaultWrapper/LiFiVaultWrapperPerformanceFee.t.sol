// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ILiFiVaultWrapper } from "lifi/VaultWrapper/interfaces/ILiFiVaultWrapper.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { LibVaultWrapperMath } from "lifi/VaultWrapper/libraries/LibVaultWrapperMath.sol";
import { FeeType, FeeConfig, DeployParams } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Tests for the performance fee (EXSC-556): high-water-mark dilution charged on
///         share-price gains only, watermark ratcheting after crystallization, preview
///         consistency with pending performance fees, interaction with the management fee,
///         and the `setFeeRate` enable/disable/bounds paths. Mirrors the direct
///         beacon-proxy setup of `LiFiVaultWrapperFees.t.sol`.
contract LiFiVaultWrapperPerformanceFeeTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal wrapper;
    LiFiVaultWrapperFactory internal factory;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal owner = makeAddr("owner");

    uint256 internal constant DEPOSIT = 1_000e18;
    uint16 internal constant PERF_RATE = 2000; // 20% of gains
    uint16 internal constant MGMT_RATE = 200; // 2% / year
    uint16 internal constant SPLIT = 8000; // integrator share used for every fee type here
    uint256 internal constant YEAR = 365 days;

    /// @dev This test contract is the `factory` for the direct beacon-proxy wrappers (it
    ///      deploys and initializes them), so the wrapper reads the global circuit breaker
    ///      back from here.
    function globalPaused() external pure returns (bool) {
        return false;
    }

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new LiFiVaultWrapper()),
            address(this)
        );
    }

    /// Charging on gains above the watermark ///

    function test_PerformanceFeeChargedOnGainAboveHwm() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);

        // At 1:1 the current PPS equals the initialize-anchored watermark: no charge.
        assertEq(_pps(), wrapper.perfHighWaterMarkPps());

        _simulateYield(200e18); // PPS ~1.2

        uint256 expectedShares = _expectedPerf(
            wrapper.totalSupply(),
            wrapper.totalAssets()
        );
        assertGt(expectedShares, 0);

        _crystallize();

        assertEq(_accruedFeeShares(), expectedShares);
        assertEq(wrapper.balanceOf(address(wrapper)), expectedShares);
        uint256 integratorPart = (expectedShares * SPLIT) / 10_000;
        assertEq(wrapper.integratorFeeShares(), integratorPart);
        assertEq(wrapper.lifiFeeShares(), expectedShares - integratorPart);

        // The minted fee-shares are worth ~20% of the 200e18 gain at the new PPS.
        assertApproxEqRel(
            wrapper.convertToAssets(expectedShares),
            (200e18 * uint256(PERF_RATE)) / 10_000,
            1e15
        );
    }

    function test_NoChargeOnNetLoss() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);

        _simulateLoss(100e18); // PPS ~0.9, below the 1.0 watermark

        uint256 hwmBefore = wrapper.perfHighWaterMarkPps();
        _crystallize();

        assertEq(_accruedFeeShares(), 0);
        assertEq(wrapper.perfHighWaterMarkPps(), hwmBefore);
    }

    function test_PerfOnYieldOnlyDepositsAloneNeverCharge() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);
        _deposit(bob, 3 * DEPOSIT);
        _deposit(alice, DEPOSIT / 2);

        // Deposits mint shares at the current PPS, so the price never moves above the
        // watermark without actual yield: nothing accrues.
        assertEq(_accruedFeeShares(), 0);
        assertEq(wrapper.balanceOf(address(wrapper)), 0);
    }

    function test_NoDoubleChargeAcrossDrawdownAndRecovery() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);

        _simulateYield(200e18);
        _crystallize(); // charged; watermark ratchets to the post-fee PPS

        uint256 hwmAfterCharge = wrapper.perfHighWaterMarkPps();
        uint256 sharesAfterCharge = _accruedFeeShares();
        assertGt(hwmAfterCharge, 1e18);

        _simulateLoss(300e18); // drawdown well below the watermark
        _crystallize();
        _simulateYield(300e18); // recover to just about the pre-drawdown level
        _crystallize();

        // The recovery back up to the watermark is NOT new performance: no extra
        // fee-shares were minted and the watermark did not move.
        assertLe(_pps(), hwmAfterCharge);
        assertEq(_accruedFeeShares(), sharesAfterCharge);
        assertEq(wrapper.perfHighWaterMarkPps(), hwmAfterCharge);

        // Only yield beyond the watermark is charged again.
        _simulateYield(100e18);
        _crystallize();

        assertGt(_accruedFeeShares(), sharesAfterCharge);
    }

    function test_HwmRatchetsToPostCrystallizationPps() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);

        _simulateYield(200e18);
        uint256 ppsBeforeCharge = _pps();
        uint256 supply = wrapper.totalSupply();
        uint256 assets = wrapper.totalAssets();
        uint256 expectedShares = _expectedPerf(supply, assets);
        uint256 expectedHwm = LibVaultWrapperMath.pricePerShare(
            supply + expectedShares,
            assets,
            0
        );

        _crystallize();

        // The watermark equals the diluted (post-fee-mint) PPS, sitting below the
        // pre-charge peak: holders' realized value is the new baseline.
        uint256 hwm = wrapper.perfHighWaterMarkPps();
        assertEq(hwm, expectedHwm);
        assertLt(hwm, ppsBeforeCharge);

        // Idempotence: crystallizing again at the same level mints nothing more.
        uint256 sharesAfterCharge = _accruedFeeShares();
        _crystallize();

        assertEq(_accruedFeeShares(), sharesAfterCharge);
    }

    function test_SubThresholdGainMintsNothingAndStaysChargeable() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);

        // A gain below one PPS unit (supply / PPS_SCALE = 1000 wei here) floors to a
        // zero-share fee: nothing is minted and, unlike the management baseline, the
        // watermark does NOT advance — the gain stays chargeable.
        _simulateYield(500);
        uint256 hwmBefore = wrapper.perfHighWaterMarkPps();
        _crystallize();

        assertEq(_accruedFeeShares(), 0);
        assertEq(wrapper.perfHighWaterMarkPps(), hwmBefore);

        // Once the cumulative gain is material it is charged in full from the original
        // watermark, not from the sub-threshold peak.
        _simulateYield(200e18);
        _crystallize();

        assertGt(_accruedFeeShares(), 0);
    }

    /// Preview == execution with pending performance fees ///

    function test_PreviewRedeemMatchesExecutionWithPendingPerf() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);
        _simulateYield(200e18); // pending, not yet crystallized

        uint256 sharesToRedeem = wrapper.balanceOf(alice) / 2;
        uint256 previewed = wrapper.previewRedeem(sharesToRedeem);

        vm.prank(alice);
        uint256 assetsOut = wrapper.redeem(sharesToRedeem, alice, alice);

        assertEq(assetsOut, previewed);
    }

    function test_PreviewDepositMatchesExecutionWithPendingPerf() public {
        wrapper = _newWrapperPerfOnly(PERF_RATE);
        _deposit(alice, DEPOSIT);
        _simulateYield(200e18);

        asset.mint(bob, DEPOSIT);
        vm.startPrank(bob);
        asset.approve(address(wrapper), DEPOSIT);
        uint256 previewed = wrapper.previewDeposit(DEPOSIT);
        uint256 minted = wrapper.deposit(DEPOSIT, bob);
        vm.stopPrank();

        assertEq(minted, previewed);
    }

    /// Interaction with the management fee ///

    function test_CombinedManagementAndPerformanceAccrueSequentially() public {
        wrapper = _newWrapperPerfAndMgmt(PERF_RATE, MGMT_RATE);
        _deposit(alice, DEPOSIT);

        _simulateYield(200e18);
        vm.warp(block.timestamp + YEAR);

        // Replicate the accrual sequence: management on elapsed time first, then
        // performance on the post-management share price.
        uint256 supply = wrapper.totalSupply();
        uint256 assets = wrapper.totalAssets();
        uint256 mgmtFeeAssets = LibVaultWrapperMath.managementFeeAssets({
            _totalAssets: assets,
            _rateBps: MGMT_RATE,
            _elapsed: YEAR
        });
        uint256 mgmtShares = LibVaultWrapperMath.dilutionShares({
            _feeAssets: mgmtFeeAssets,
            _totalSupply: supply,
            _totalAssets: assets,
            _decimalsOffset: 0
        });
        uint256 perfShares = _expectedPerf(supply + mgmtShares, assets);
        assertGt(mgmtShares, 0);
        assertGt(perfShares, 0);

        _crystallize();

        assertEq(_accruedFeeShares(), mgmtShares + perfShares);
        assertEq(wrapper.balanceOf(address(wrapper)), mgmtShares + perfShares);
    }

    function test_ManagementDilutionAloneNeverTriggersPerformanceFee() public {
        wrapper = _newWrapperPerfAndMgmt(PERF_RATE, MGMT_RATE);
        _deposit(alice, DEPOSIT);

        // No yield: management dilution only ever LOWERS the PPS, which can never
        // exceed the watermark.
        vm.warp(block.timestamp + YEAR);
        _crystallize();

        uint256 supply = wrapper.totalSupply();
        uint256 assets = wrapper.totalAssets();
        assertGt(_accruedFeeShares(), 0); // management accrued...
        assertEq(_expectedPerf(supply, assets), 0); // ...but no perf is pending
        assertLt(_pps(), wrapper.perfHighWaterMarkPps());
    }

    /// setFeeRate: enable / disable / bounds ///

    function test_SetFeeRateEnablePerformanceReanchorsHwm() public {
        _stackWithFactory(0); // performance disabled at deploy
        _deposit(alice, DEPOSIT);

        // Yield earned while the fee is disabled must never be charged retroactively.
        _simulateYield(200e18);

        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Performance, PERF_RATE);

        // The watermark re-anchored at the current (post-yield) PPS...
        assertEq(wrapper.perfHighWaterMarkPps(), _pps());
        assertEq(_accruedFeeShares(), 0);

        // ...so crystallizing right away charges nothing...
        _crystallize();

        assertEq(_accruedFeeShares(), 0);

        // ...and only NEW yield is charged.
        _simulateYield(100e18);
        _crystallize();

        assertGt(_accruedFeeShares(), 0);
    }

    function test_SetFeeRateDisablePerformanceCrystallizesFirst() public {
        _stackWithFactory(PERF_RATE);
        _deposit(alice, DEPOSIT);
        _simulateYield(200e18);

        uint256 expectedShares = _expectedPerf(
            wrapper.totalSupply(),
            wrapper.totalAssets()
        );
        assertGt(expectedShares, 0);

        // Turning the fee off prices the pending gain at the OLD rate first.
        vm.prank(vaultAdmin);
        wrapper.setFeeRate(FeeType.Performance, 0);

        assertEq(_accruedFeeShares(), expectedShares);
        assertFalse(wrapper.feeEnabled(uint8(FeeType.Performance)));

        // Further yield accrues nothing while disabled.
        _simulateYield(100e18);
        _crystallize();

        assertEq(_accruedFeeShares(), expectedShares);
    }

    function testRevert_SetFeeRatePerformanceOutOfBounds() public {
        _stackWithFactory(PERF_RATE);
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Performance, 100, 5000);

        vm.prank(vaultAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ILiFiVaultWrapper.FeeRateOutOfBounds.selector,
                uint16(50),
                uint16(100),
                uint16(5000)
            )
        );
        wrapper.setFeeRate(FeeType.Performance, 50);
    }

    /// Split ///

    function test_PerformanceFeeSplitUsesPerformanceShare() public {
        uint16[4] memory rates = [PERF_RATE, 0, 0, 0];
        bool[4] memory enabled = [true, false, false, false];
        // Performance split differs from every other type's share (all zero here).
        wrapper = _newWrapperWithSplits(
            FeeConfig({ rateBps: rates, enabled: enabled }),
            [uint16(4500), 0, 0, 0]
        );
        _deposit(alice, DEPOSIT);
        _simulateYield(200e18);

        uint256 expectedShares = _expectedPerf(
            wrapper.totalSupply(),
            wrapper.totalAssets()
        );

        _crystallize();

        uint256 integratorPart = (expectedShares * 4500) / 10_000;
        assertEq(wrapper.integratorFeeShares(), integratorPart);
        assertEq(wrapper.lifiFeeShares(), expectedShares - integratorPart);
    }

    /// Helpers ///

    function _newWrapperWithSplits(
        FeeConfig memory _fees,
        uint16[4] memory _splits
    ) internal returns (LiFiVaultWrapper w) {
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(underlying),
                address(adapter),
                vaultAdmin,
                _splits,
                _fees,
                ""
            )
        );

        w = LiFiVaultWrapper(
            address(new BeaconProxy(address(beacon), initCall))
        );
    }

    function _newWrapperPerfOnly(
        uint16 _rate
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [_rate, 0, 0, 0];
        bool[4] memory enabled = [_rate != 0, false, false, false];

        return
            _newWrapperWithSplits(
                FeeConfig({ rateBps: rates, enabled: enabled }),
                [SPLIT, SPLIT, SPLIT, SPLIT]
            );
    }

    function _newWrapperPerfAndMgmt(
        uint16 _perf,
        uint16 _mgmt
    ) internal returns (LiFiVaultWrapper) {
        uint16[4] memory rates = [_perf, _mgmt, 0, 0];
        bool[4] memory enabled = [true, true, false, false];

        return
            _newWrapperWithSplits(
                FeeConfig({ rateBps: rates, enabled: enabled }),
                [SPLIT, SPLIT, SPLIT, SPLIT]
            );
    }

    /// @dev Stands up the full factory stack and deploys an instance so `setFeeRate`
    ///      reads live `feeBounds` (performance bounds 0..5000).
    function _stackWithFactory(uint16 _perfRate) internal {
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
        factory.setFeeBounds(FeeType.Performance, 0, 5000);
        vm.stopPrank();

        uint16[4] memory rates = [_perfRate, 0, 0, 0];
        bool[4] memory enabled = [_perfRate != 0, false, false, false];
        DeployParams memory p = DeployParams({
            namespace: bytes32("Coinbase"),
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: 0,
            fees: FeeConfig({ rateBps: rates, enabled: enabled }),
            integratorShareBps: [
                type(uint16).max,
                type(uint16).max,
                type(uint16).max,
                type(uint16).max
            ],
            initData: ""
        });

        vm.prank(makeAddr("onboarder"));
        wrapper = LiFiVaultWrapper(factory.deploy(p));
    }

    /// @dev Replicates the pending performance fee for a given state against the
    ///      wrapper's stored watermark, mirroring `_pendingPerformanceFee`.
    function _expectedPerf(
        uint256 _supply,
        uint256 _assets
    ) internal view returns (uint256) {
        uint256 feeAssets = LibVaultWrapperMath.performanceFeeAssets({
            _totalAssets: _assets,
            _totalSupply: _supply,
            _hwmPps: wrapper.perfHighWaterMarkPps(),
            _rateBps: wrapper.feeRate(uint8(FeeType.Performance)),
            _decimalsOffset: 0
        });

        return
            LibVaultWrapperMath.dilutionShares({
                _feeAssets: feeAssets,
                _totalSupply: _supply,
                _totalAssets: _assets,
                _decimalsOffset: 0
            });
    }

    function _pps() internal view returns (uint256) {
        return
            LibVaultWrapperMath.pricePerShare(
                wrapper.totalSupply(),
                wrapper.totalAssets(),
                0
            );
    }

    function _accruedFeeShares() internal view returns (uint256) {
        return
            uint256(wrapper.lifiFeeShares()) + wrapper.integratorFeeShares();
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

    function _simulateLoss(uint256 _amount) internal {
        deal(
            address(asset),
            address(underlying),
            asset.balanceOf(address(underlying)) - _amount
        );
    }

    /// @dev Triggers `_beforeOperation -> _accrueFees` via a dust deposit. 1 gwei (vs a
    ///      1000e18 base) so solmate's MockERC4626 does not revert ZERO_SHARES once its
    ///      own PPS exceeds 1 after simulated yield; the accrual runs before the
    ///      deposit's own mint, so fee bookkeeping is exact regardless of this dust.
    function _crystallize() internal {
        asset.mint(address(this), 1e9);
        asset.approve(address(wrapper), 1e9);
        wrapper.deposit(1e9, address(this));
    }
}
