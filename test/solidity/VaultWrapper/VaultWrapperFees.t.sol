// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { MockERC20 } from "solmate/test/utils/mocks/MockERC20.sol";
import { MockERC4626 } from "solmate/test/utils/mocks/MockERC4626.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { VaultWrapperFeeDistributor } from "lifi/VaultWrapper/VaultWrapperFeeDistributor.sol";
import { VaultWrapperPausable } from "lifi/VaultWrapper/VaultWrapperPausable.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeConfig } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

/// @notice Exposes the internal fee-routing seam so distribution can be unit-tested without
///         the S2 accrual engine (which fills the pools in production) being present.
contract FeeHarness is LiFiVaultWrapper {
    function harnessRouteFee(uint256 _fee) external {
        _routeFee(_fee);
    }
}

/// @notice Factory stand-in: deploys the instance (so it is the `factory`) and exposes the
///         live LI.FI recipient, global pause flag, and emergency authority the wrapper reads.
contract MockFeeFactory {
    bool public globalPaused;
    address public emergencyPauser;
    address public lifiFeeRecipient;

    constructor(address _emergencyPauser, address _lifiFeeRecipient) {
        emergencyPauser = _emergencyPauser;
        lifiFeeRecipient = _lifiFeeRecipient;
    }

    function setGlobalPaused(bool _paused) external {
        globalPaused = _paused;
    }

    function setLifiFeeRecipient(address _recipient) external {
        lifiFeeRecipient = _recipient;
    }

    function deployWrapper(
        address _beacon,
        bytes calldata _initCall
    ) external returns (address) {
        return address(new BeaconProxy(_beacon, _initCall));
    }
}

/// @notice ERC20 that can be armed to revert on transfer to a blacklisted address, or to
///         re-enter the wrapper's sweep on transfer, to exercise sweep robustness.
contract HostileAsset is MockERC20 {
    error Blacklisted();

    address public blacklisted;
    address public reenterTarget;

    constructor() MockERC20("Hostile", "HST", 18) {}

    function setBlacklisted(address _account) external {
        blacklisted = _account;
    }

    function setReenterTarget(address _target) external {
        reenterTarget = _target;
    }

    function transfer(
        address _to,
        uint256 _amount
    ) public override returns (bool ok) {
        if (_to == blacklisted) revert Blacklisted();
        ok = super.transfer(_to, _amount);
        if (_to == reenterTarget && reenterTarget != address(0))
            IReenterSweep(reenterTarget).reenter();
    }
}

interface IReenterSweep {
    function reenter() external;
}

/// @notice Integrator receiver that re-enters sweep() when it receives the hostile asset.
contract ReentrantReceiver is IReenterSweep {
    address public immutable WRAPPER;

    constructor(address _wrapper) {
        WRAPPER = _wrapper;
    }

    function reenter() external {
        LiFiVaultWrapper(WRAPPER).sweep();
    }
}

contract VaultWrapperFeesTest is Test {
    MockERC20 internal asset;
    MockERC4626 internal underlying;
    ERC4626Adapter internal adapter;
    UpgradeableBeacon internal beacon;
    MockFeeFactory internal factory;
    FeeHarness internal wrapper;

    address internal lifiPauser = makeAddr("lifiPauser");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal r1 = makeAddr("r1");
    address internal r2 = makeAddr("r2");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant SHARE_BPS = 8000; // integrator 80% / LI.FI 20%
    uint256 internal constant FEE = 1_000e18;

    event ReceiversSet(address[] receivers, uint16[] bps);
    event LifiFeesSwept(uint256 amount, address indexed recipient);
    event IntegratorFeesSwept(uint256 amount);

    function setUp() public {
        asset = new MockERC20("Token", "TKN", 18);
        underlying = new MockERC4626(asset, "Yield Token", "yTKN");
        adapter = new ERC4626Adapter();
        beacon = new UpgradeableBeacon(
            address(new FeeHarness()),
            address(this)
        );
        factory = new MockFeeFactory(lifiPauser, lifiRecipient);
        wrapper = _deployWrapper(SHARE_BPS);
    }

    /// Routing ///

    function test_RouteFeeSplitsByIntegratorShareBps() public {
        wrapper.harnessRouteFee(FEE);

        assertEq(wrapper.integratorFeesAccrued(), 800e18);
        assertEq(wrapper.lifiFeesAccrued(), 200e18);
    }

    function test_RouteFeeAccumulates() public {
        wrapper.harnessRouteFee(FEE);
        wrapper.harnessRouteFee(FEE);

        assertEq(wrapper.integratorFeesAccrued(), 1_600e18);
        assertEq(wrapper.lifiFeesAccrued(), 400e18);
    }

    function test_RouteFeeZeroIsNoOp() public {
        wrapper.harnessRouteFee(0);

        assertEq(wrapper.integratorFeesAccrued(), 0);
        assertEq(wrapper.lifiFeesAccrued(), 0);
    }

    /// Receiver configuration ///

    function test_SetIntegratorReceiversStoresConfig() public {
        _setReceivers2(6000, 4000);

        address[] memory got = wrapper.integratorReceivers();
        uint16[] memory gotBps = wrapper.integratorReceiverBps();
        assertEq(got.length, 2);
        assertEq(got[0], r1);
        assertEq(got[1], r2);
        assertEq(gotBps[0], 6000);
        assertEq(gotBps[1], 4000);
    }

    function test_SetIntegratorReceiversEmits() public {
        (address[] memory rs, uint16[] memory bps) = _receivers2(6000, 4000);

        vm.expectEmit(true, true, true, true);
        emit ReceiversSet(rs, bps);

        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversNonAdmin() public {
        (address[] memory rs, uint16[] memory bps) = _receivers2(6000, 4000);

        vm.prank(stranger);
        vm.expectRevert(VaultWrapperPausable.NotIntegratorAdmin.selector);

        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversEmpty() public {
        address[] memory rs = new address[](0);
        uint16[] memory bps = new uint16[](0);

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperFeeDistributor.InvalidReceiverCount.selector
        );

        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversTooMany() public {
        address[] memory rs = new address[](6);
        uint16[] memory bps = new uint16[](6);
        for (uint256 i; i < 6; i++) {
            rs[i] = address(uint160(i + 1));
            bps[i] = i == 5 ? 5000 : 1000;
        }

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperFeeDistributor.InvalidReceiverCount.selector
        );

        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversLengthMismatch() public {
        address[] memory rs = new address[](2);
        rs[0] = r1;
        rs[1] = r2;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperFeeDistributor.ReceiversLengthMismatch.selector
        );

        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversZeroAddress() public {
        address[] memory rs = new address[](1);
        rs[0] = address(0);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;

        vm.prank(vaultAdmin);
        vm.expectRevert(VaultWrapperFeeDistributor.ZeroReceiver.selector);

        wrapper.setIntegratorReceivers(rs, bps);
    }

    function testRevert_SetReceiversSumNot100() public {
        (address[] memory rs, uint16[] memory bps) = _receivers2(6000, 3000);

        vm.prank(vaultAdmin);
        vm.expectRevert(
            VaultWrapperFeeDistributor.ReceiverBpsSumNot100.selector
        );

        wrapper.setIntegratorReceivers(rs, bps);
    }

    /// Sweep distribution ///

    function test_SweepDistributesBothPools() public {
        _setReceivers2(6000, 4000);
        _seed(FEE);

        vm.expectEmit(true, true, true, true);
        emit LifiFeesSwept(200e18, lifiRecipient);
        vm.expectEmit(true, true, true, true);
        emit IntegratorFeesSwept(800e18);

        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(lifiRecipient), 200e18);
        assertEq(asset.balanceOf(r1), 480e18); // 800 * 60%
        assertEq(asset.balanceOf(r2), 320e18); // 800 * 40%
        assertEq(wrapper.lifiFeesAccrued(), 0);
        assertEq(wrapper.integratorFeesAccrued(), 0);
        assertEq(asset.balanceOf(address(wrapper)), 0);
    }

    function test_SweepSingleReceiverTakesWholeIntegratorPool() public {
        address[] memory rs = new address[](1);
        rs[0] = r1;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;
        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs, bps);
        _seed(FEE);

        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(r1), 800e18);
        assertEq(asset.balanceOf(lifiRecipient), 200e18);
    }

    function test_SweepFiveReceiversDistributesByBps() public {
        address[] memory rs = new address[](5);
        uint16[] memory bps = new uint16[](5);
        for (uint256 i; i < 5; i++) {
            rs[i] = address(uint160(0x1000 + i));
            bps[i] = 2000; // 5 x 20%
        }
        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs, bps);
        _seed(FEE);

        vm.prank(stranger);
        wrapper.sweep();

        for (uint256 i; i < 5; i++) {
            assertEq(asset.balanceOf(rs[i]), 160e18); // 800 / 5
        }
    }

    function test_SweepRoundingRemainderGoesToLastReceiver() public {
        // Two receivers at 1/3 and 2/3 of an amount that does not divide evenly.
        address[] memory rs = new address[](2);
        rs[0] = r1;
        rs[1] = r2;
        uint16[] memory bps = new uint16[](2);
        bps[0] = 3333;
        bps[1] = 6667;
        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs, bps);

        // 7 wei integrator pool: with SHARE_BPS=8000, route 9 wei -> int 7, lifi 2.
        _seed(9);
        uint256 integratorPool = wrapper.integratorFeesAccrued();

        vm.prank(stranger);
        wrapper.sweep();

        // r0 = floor(7 * 3333 / 10000) = 2; r1 absorbs remainder = 5; sum == pool.
        assertEq(asset.balanceOf(r1), 2);
        assertEq(asset.balanceOf(r2), integratorPool - 2);
        assertEq(asset.balanceOf(address(wrapper)), 0);
    }

    function test_SweepIsPermissionless() public {
        _setReceivers2(5000, 5000);
        _seed(FEE);

        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(r1), 400e18);
    }

    function test_SweepWorksWhilePaused() public {
        _setReceivers2(5000, 5000);
        _seed(FEE);

        vm.prank(lifiPauser);
        wrapper.emergencyPause();
        vm.prank(vaultAdmin);
        wrapper.integratorPause();
        factory.setGlobalPaused(true);

        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(lifiRecipient), 200e18);
        assertEq(asset.balanceOf(r1), 400e18);
        assertEq(asset.balanceOf(r2), 400e18);
    }

    function test_SweepEmptyPoolsIsNoOp() public {
        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(lifiRecipient), 0);
    }

    /// LI.FI cannot be held hostage by integrator receiver config ///

    function test_SweepPaysLifiAndLeavesIntegratorAccruedWhenNoReceivers()
        public
    {
        _seed(FEE); // both pools owed, but no integrator receivers configured

        vm.prank(stranger);
        wrapper.sweep();

        // LI.FI is paid; the integrator portion stays accrued for a later sweep.
        assertEq(asset.balanceOf(lifiRecipient), 200e18);
        assertEq(wrapper.lifiFeesAccrued(), 0);
        assertEq(wrapper.integratorFeesAccrued(), 800e18);

        // Once receivers are configured, a second sweep distributes the integrator pool.
        _setReceivers2(5000, 5000);
        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(r1), 400e18);
        assertEq(asset.balanceOf(r2), 400e18);
        assertEq(wrapper.integratorFeesAccrued(), 0);
    }

    function test_SweepLifiFeesEscapeHatchBypassesRevertingReceiver() public {
        // A wrapper over a hostile asset whose integrator receiver reverts on receipt.
        HostileAsset hostile = new HostileAsset();
        MockERC4626 hostileUnderlying = new MockERC4626(
            hostile,
            "yHST",
            "yHST"
        );
        FeeHarness w = _deployFor(
            address(hostile),
            address(hostileUnderlying)
        );

        address badReceiver = makeAddr("badReceiver");
        hostile.setBlacklisted(badReceiver);
        address[] memory rs = new address[](1);
        rs[0] = badReceiver;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;
        vm.prank(vaultAdmin);
        w.setIntegratorReceivers(rs, bps);

        hostile.mint(address(w), FEE);
        w.harnessRouteFee(FEE);

        // The combined sweep reverts because the integrator transfer reverts...
        vm.expectRevert(HostileAsset.Blacklisted.selector);
        w.sweep();

        // ...but LI.FI can still collect its share via the escape hatch.
        vm.prank(stranger);
        w.sweepLifiFees();

        assertEq(hostile.balanceOf(lifiRecipient), 200e18);
        assertEq(w.lifiFeesAccrued(), 0);
    }

    function testRevert_SweepReentrancyBlocked() public {
        HostileAsset hostile = new HostileAsset();
        MockERC4626 hostileUnderlying = new MockERC4626(
            hostile,
            "yHST",
            "yHST"
        );
        FeeHarness w = _deployFor(
            address(hostile),
            address(hostileUnderlying)
        );

        ReentrantReceiver attacker = new ReentrantReceiver(address(w));
        hostile.setReenterTarget(address(attacker));
        address[] memory rs = new address[](1);
        rs[0] = address(attacker);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;
        vm.prank(vaultAdmin);
        w.setIntegratorReceivers(rs, bps);

        hostile.mint(address(w), FEE);
        w.harnessRouteFee(FEE);

        // The re-entrant sweep() from the receiver hits the reentrancy guard.
        vm.expectRevert();
        w.sweep();
    }

    function test_LifiRecipientIsReadLiveAtSweep() public {
        _setReceivers2(5000, 5000);
        _seed(FEE);

        address newRecipient = makeAddr("newLifiRecipient");
        factory.setLifiFeeRecipient(newRecipient);

        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(newRecipient), 200e18);
        assertEq(asset.balanceOf(lifiRecipient), 0);
    }

    function test_ReconfigureToSmallerReceiverSet() public {
        address[] memory rs3 = new address[](3);
        uint16[] memory bps3 = new uint16[](3);
        for (uint256 i; i < 3; i++) {
            rs3[i] = address(uint160(0x2000 + i));
            bps3[i] = i == 2 ? 3334 : 3333;
        }
        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs3, bps3);

        _setReceivers2(5000, 5000); // shrink 3 -> 2

        assertEq(wrapper.integratorReceivers().length, 2);
        _seed(FEE);
        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(r1), 400e18);
        assertEq(asset.balanceOf(r2), 400e18);
        assertEq(asset.balanceOf(rs3[2]), 0); // dropped receiver gets nothing
    }

    function test_IntegratorFullShareLeavesLifiPoolEmpty() public {
        FeeHarness w = _deployWrapper(10000); // integrator 100%, LI.FI 0%
        address[] memory rs = new address[](1);
        rs[0] = r1;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;
        vm.prank(vaultAdmin);
        w.setIntegratorReceivers(rs, bps);

        asset.mint(address(w), FEE);
        w.harnessRouteFee(FEE);

        assertEq(w.lifiFeesAccrued(), 0);
        assertEq(w.integratorFeesAccrued(), FEE);

        vm.prank(stranger);
        w.sweep();

        assertEq(asset.balanceOf(r1), FEE);
        assertEq(asset.balanceOf(lifiRecipient), 0);
    }

    function test_SweepLifiOnlyPoolNeedsNoReceivers() public {
        // integratorShareBps = 0 -> the whole fee accrues to LI.FI.
        FeeHarness w = _deployWrapper(0);
        asset.mint(address(w), FEE);
        w.harnessRouteFee(FEE);

        vm.prank(stranger);
        w.sweep();

        assertEq(asset.balanceOf(lifiRecipient), FEE);
        assertEq(w.lifiFeesAccrued(), 0);
    }

    /// Helpers ///

    function _deployWrapper(uint16 _shareBps) internal returns (FeeHarness w) {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                address(asset),
                address(underlying),
                address(adapter),
                vaultAdmin,
                _shareBps,
                fees,
                ""
            )
        );
        w = FeeHarness(factory.deployWrapper(address(beacon), initCall));
    }

    /// @dev Deploy a wrapper over an arbitrary asset/underlying (default split).
    function _deployFor(
        address _asset,
        address _underlying
    ) internal returns (FeeHarness w) {
        FeeConfig memory fees;
        bytes memory initCall = abi.encodeCall(
            LiFiVaultWrapper.initialize,
            (
                _asset,
                _underlying,
                address(adapter),
                vaultAdmin,
                SHARE_BPS,
                fees,
                ""
            )
        );
        w = FeeHarness(factory.deployWrapper(address(beacon), initCall));
    }

    /// @dev Fund the wrapper with the fee assets and record the split into the pools,
    ///      mirroring what a real deposit/withdraw skim does once accrual lands.
    function _seed(uint256 _fee) internal {
        asset.mint(address(wrapper), _fee);
        wrapper.harnessRouteFee(_fee);
    }

    function _receivers2(
        uint16 _bps1,
        uint16 _bps2
    ) internal view returns (address[] memory rs, uint16[] memory bps) {
        rs = new address[](2);
        rs[0] = r1;
        rs[1] = r2;
        bps = new uint16[](2);
        bps[0] = _bps1;
        bps[1] = _bps2;
    }

    function _setReceivers2(uint16 _bps1, uint16 _bps2) internal {
        (address[] memory rs, uint16[] memory bps) = _receivers2(_bps1, _bps2);
        vm.prank(vaultAdmin);
        wrapper.setIntegratorReceivers(rs, bps);
    }
}
