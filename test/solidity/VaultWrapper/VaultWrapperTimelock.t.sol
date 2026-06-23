// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";

/// @title VaultWrapperTimelockTest
/// @notice Integration tests for the dedicated 48h timelock that governs the vault
///         wrapper factory slow-path and beacon upgrades (S10).
contract VaultWrapperTimelockTest is Test {
    uint256 internal constant MIN_DELAY = 48 hours;

    TimelockController internal timelock;
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    MockVaultWrapper internal impl;
    ERC4626Adapter internal adapter;

    address internal multisig = makeAddr("multisig");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));

        address[] memory proposers = new address[](1);
        proposers[0] = multisig;

        address[] memory executors = new address[](1);
        executors[0] = address(0);

        timelock = new TimelockController(
            MIN_DELAY,
            proposers,
            executors,
            address(0)
        );

        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            address(timelock),
            pauser,
            onboarder,
            lifiRecipient
        );
        beacon.transferOwnership(address(timelock));

        adapter = new ERC4626Adapter();
    }

    /// Wiring ///

    function test_TimelockOwnsFactoryAndBeacon() public view {
        assertEq(factory.owner(), address(timelock));
        assertEq(beacon.owner(), address(timelock));
    }

    function test_TimelockRolesAndDelay() public view {
        assertEq(timelock.getMinDelay(), MIN_DELAY);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertTrue(
            timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), address(timelock))
        );
        assertFalse(
            timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), address(this))
        );
        assertFalse(
            timelock.hasRole(timelock.TIMELOCK_ADMIN_ROLE(), multisig)
        );
    }

    /// Slow-path gating ///

    function test_SlowPathExecutesAfterDelay() public {
        bytes memory data = abi.encodeCall(
            factory.setAdapterApproved,
            (address(adapter), true)
        );

        _schedule(address(factory), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(multisig, address(factory), data);

        assertTrue(factory.approvedAdapter(address(adapter)));
    }

    function testRevert_SlowPathExecuteBeforeDelay() public {
        bytes memory data = abi.encodeCall(
            factory.setAdapterApproved,
            (address(adapter), true)
        );

        _schedule(address(factory), data);

        vm.prank(multisig);
        vm.expectRevert("TimelockController: operation is not ready");

        timelock.execute(address(factory), 0, data, bytes32(0), bytes32(0));
    }

    function testRevert_DirectSlowPathCallByMultisig() public {
        vm.prank(multisig);
        vm.expectRevert(UnAuthorized.selector);

        factory.setAdapterApproved(address(adapter), true);
    }

    function test_PermissionlessExecuteByStranger() public {
        bytes memory data = abi.encodeCall(
            factory.setUnderlyingAllowed,
            (makeAddr("underlying"), true)
        );

        _schedule(address(factory), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(stranger, address(factory), data);

        assertTrue(factory.allowedUnderlying(makeAddr("underlying")));
    }

    /// Cancellation ///

    function test_CancelBeforeExecute() public {
        bytes memory data = abi.encodeCall(
            factory.setAdapterApproved,
            (address(adapter), true)
        );

        _schedule(address(factory), data);
        bytes32 id = timelock.hashOperation(
            address(factory),
            0,
            data,
            bytes32(0),
            bytes32(0)
        );
        assertTrue(timelock.isOperationPending(id));

        vm.prank(multisig);
        timelock.cancel(id);

        assertFalse(timelock.isOperation(id));
        assertFalse(factory.approvedAdapter(address(adapter)));
    }

    function testRevert_ExecuteAfterCancel() public {
        bytes memory data = abi.encodeCall(
            factory.setAdapterApproved,
            (address(adapter), true)
        );

        _schedule(address(factory), data);
        bytes32 id = timelock.hashOperation(
            address(factory),
            0,
            data,
            bytes32(0),
            bytes32(0)
        );

        vm.prank(multisig);
        timelock.cancel(id);

        vm.warp(block.timestamp + MIN_DELAY);

        vm.prank(multisig);
        vm.expectRevert("TimelockController: operation is not ready");

        timelock.execute(address(factory), 0, data, bytes32(0), bytes32(0));
    }

    /// Beacon upgrade gating ///

    function test_BeaconUpgradeViaTimelock() public {
        MockVaultWrapper newImpl = new MockVaultWrapper();
        bytes memory data = abi.encodeCall(
            beacon.upgradeTo,
            (address(newImpl))
        );

        _schedule(address(beacon), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(stranger, address(beacon), data);

        assertEq(beacon.implementation(), address(newImpl));
    }

    function testRevert_BeaconUpgradeDirectByMultisig() public {
        MockVaultWrapper newImpl = new MockVaultWrapper();

        vm.prank(multisig);
        vm.expectRevert("Ownable: caller is not the owner");

        beacon.upgradeTo(address(newImpl));
    }

    /// Emergency pause stays outside the timelock ///

    function test_EmergencyPauseBypassesTimelock() public {
        vm.prank(pauser);
        factory.globalPause();

        assertTrue(factory.globalPaused());
    }

    function testRevert_PauserRotationDirectByMultisig() public {
        vm.prank(multisig);
        vm.expectRevert(UnAuthorized.selector);

        factory.setEmergencyPauser(makeAddr("newPauser"));
    }

    function test_PauserRotationViaTimelock() public {
        address newPauser = makeAddr("newPauser");
        bytes memory data = abi.encodeCall(
            factory.setEmergencyPauser,
            (newPauser)
        );

        _schedule(address(factory), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(multisig, address(factory), data);

        assertEq(factory.emergencyPauser(), newPauser);
    }

    /// Helpers ///

    function _schedule(address target, bytes memory data) internal {
        vm.prank(multisig);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), MIN_DELAY);
    }

    function _execute(
        address caller,
        address target,
        bytes memory data
    ) internal {
        vm.prank(caller);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
    }
}
