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

    function deployWrapper(
        address _beacon,
        bytes calldata _initCall
    ) external returns (address) {
        return address(new BeaconProxy(_beacon, _initCall));
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
    event FeesSwept(
        uint256 lifiAmount,
        uint256 integratorAmount,
        address indexed lifiRecipient
    );

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
        emit FeesSwept(200e18, 800e18, lifiRecipient);

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
    }

    function test_SweepEmptyPoolsIsNoOp() public {
        vm.prank(stranger);
        wrapper.sweep();

        assertEq(asset.balanceOf(lifiRecipient), 0);
    }

    function testRevert_SweepWithoutReceiversWhenIntegratorPoolOwed() public {
        _seed(FEE); // integrator pool > 0 but no receivers configured

        vm.expectRevert(
            VaultWrapperFeeDistributor.NoReceiversConfigured.selector
        );

        vm.prank(stranger);
        wrapper.sweep();
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
