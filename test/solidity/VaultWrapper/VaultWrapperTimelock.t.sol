// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import { ITransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { VaultWrapperFactoryDeployer } from "test/solidity/VaultWrapper/VaultWrapperTestHelpers.sol";

/// @notice Upgrade target proving a factory-logic upgrade takes effect: extends the
///         factory (identical storage layout) and adds a version() selector absent
///         from V1.
contract MockFactoryV2 is LiFiVaultWrapperFactory {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @title VaultWrapperTimelockTest
/// @notice Integration tests for the dedicated 48h timelock that governs the vault
///         wrapper factory slow-path, beacon upgrades, and factory-logic upgrades (S10).
contract VaultWrapperTimelockTest is Test {
    uint256 internal constant MIN_DELAY = 48 hours;

    TimelockController internal timelock;
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    ERC4626Adapter internal adapter;

    address internal multisig = makeAddr("multisig");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
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

        // The timelock owns the beacon, the factory, and the factory proxy's ProxyAdmin,
        // so every beacon upgrade, factory slow-path call, and factory-logic upgrade is
        // gated by the 48h delay.
        (beacon, factory) = VaultWrapperFactoryDeployer.deploy(
            address(timelock),
            address(timelock),
            pauser,
            onboarder,
            lifiRecipient
        );

        adapter = new ERC4626Adapter();
    }

    /// Wiring ///

    function test_TimelockOwnsFactoryAndBeacon() public view {
        assertEq(factory.owner(), address(timelock));
        assertEq(beacon.owner(), address(timelock));

        ProxyAdmin admin = ProxyAdmin(
            VaultWrapperFactoryDeployer.proxyAdmin(address(factory))
        );
        assertEq(admin.owner(), address(timelock));
    }

    function test_TimelockRolesAndDelay() public view {
        assertEq(timelock.getMinDelay(), MIN_DELAY);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertTrue(
            timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock))
        );
        assertFalse(
            timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this))
        );
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), multisig));
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
        bytes32 id = timelock.hashOperation(
            address(factory),
            0,
            data,
            bytes32(0),
            bytes32(0)
        );

        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                id,
                bytes32(
                    uint256(1) <<
                        uint8(TimelockController.OperationState.Ready)
                )
            )
        );

        timelock.execute(address(factory), 0, data, bytes32(0), bytes32(0));
    }

    function testRevert_DirectSlowPathCallByMultisig() public {
        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                multisig
            )
        );

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
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                id,
                bytes32(
                    uint256(1) <<
                        uint8(TimelockController.OperationState.Ready)
                )
            )
        );

        timelock.execute(address(factory), 0, data, bytes32(0), bytes32(0));
    }

    /// Beacon upgrade gating ///

    function test_BeaconUpgradeViaTimelock() public {
        LiFiVaultWrapper newImpl = new LiFiVaultWrapper(address(factory));
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
        LiFiVaultWrapper newImpl = new LiFiVaultWrapper(address(factory));

        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                multisig
            )
        );

        beacon.upgradeTo(address(newImpl));
    }

    /// Factory-logic upgrade gating ///

    function test_FactoryLogicUpgradeViaTimelock() public {
        ProxyAdmin admin = ProxyAdmin(
            VaultWrapperFactoryDeployer.proxyAdmin(address(factory))
        );
        address newLogic = address(new LiFiVaultWrapperFactory());
        bytes memory data = abi.encodeCall(
            ProxyAdmin.upgradeAndCall,
            (ITransparentUpgradeableProxy(address(factory)), newLogic, "")
        );

        _schedule(address(admin), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(stranger, address(admin), data);

        assertEq(factory.beacon(), address(beacon));
        assertEq(factory.owner(), address(timelock));
    }

    function test_FactoryLogicUpgradePreservesStateAndAddsBehavior() public {
        // A pre-upgrade state change that must survive the upgrade.
        vm.prank(onboarder);
        factory.setApprovedIntegratorDeployer(bytes32("NS"), stranger);

        ProxyAdmin admin = ProxyAdmin(
            VaultWrapperFactoryDeployer.proxyAdmin(address(factory))
        );
        address newLogic = address(new MockFactoryV2());
        bytes memory data = abi.encodeCall(
            ProxyAdmin.upgradeAndCall,
            (ITransparentUpgradeableProxy(address(factory)), newLogic, "")
        );

        _schedule(address(admin), data);
        vm.warp(block.timestamp + MIN_DELAY);
        _execute(stranger, address(admin), data);

        assertEq(MockFactoryV2(address(factory)).version(), 2);
        assertEq(factory.approvedIntegratorDeployer(bytes32("NS")), stranger);
        assertEq(factory.beacon(), address(beacon));
        assertEq(factory.owner(), address(timelock));
    }

    function testRevert_FactoryLogicUpgradeDirectByMultisig() public {
        ProxyAdmin admin = ProxyAdmin(
            VaultWrapperFactoryDeployer.proxyAdmin(address(factory))
        );
        address newLogic = address(new LiFiVaultWrapperFactory());

        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                multisig
            )
        );

        admin.upgradeAndCall(
            ITransparentUpgradeableProxy(address(factory)),
            newLogic,
            ""
        );
    }

    /// Emergency pause stays outside the timelock ///

    function test_EmergencyPauseBypassesTimelock() public {
        vm.prank(pauser);
        factory.globalPause();

        assertTrue(factory.globalPaused());
    }

    function testRevert_PauserRotationDirectByMultisig() public {
        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                multisig
            )
        );

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
