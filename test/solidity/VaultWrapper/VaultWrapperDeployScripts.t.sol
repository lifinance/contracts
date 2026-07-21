// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { ICREATE3Factory } from "create3-factory/ICREATE3Factory.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { LiFiVaultWrapper } from "lifi/VaultWrapper/LiFiVaultWrapper.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { FeeType, FEE_TYPE_COUNT } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { DeployLiFiVaultWrapperFactory } from "../../../script/deploy/vaultWrapper/DeployLiFiVaultWrapperFactory.s.sol";
import { UpdateVaultWrapperConfig } from "../../../script/deploy/vaultWrapper/UpdateVaultWrapperConfig.s.sol";

/// @title VaultWrapperDeployScriptsTest
/// @author LI.FI (https://li.fi)
/// @notice Exercises the S14 deploy + config scripts locally: the CREATE3 system
///         deploy and its wiring, and the timelock config batch that seeds the
///         factory (adapter approval, allowlist, fee bounds, default split).
contract VaultWrapperDeployScriptsTest is Test {
    uint256 internal constant MIN_DELAY = 48 hours;
    uint16 internal constant TEST_SPLIT_BPS = 7000;

    uint256 internal deployerPk = uint256(keccak256("vw-deployer"));

    address internal multisig = makeAddr("multisig");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal underlying = makeAddr("underlying");

    CREATE3Factory internal create3;
    DeployLiFiVaultWrapperFactory internal deployScript;
    UpdateVaultWrapperConfig internal configScript;

    LiFiVaultWrapperFactory internal factory;
    TimelockController internal timelock;
    UpgradeableBeacon internal beacon;
    LiFiVaultWrapper internal impl;
    ERC4626Adapter internal adapter;

    function setUp() public {
        create3 = new CREATE3Factory();
        deployScript = new DeployLiFiVaultWrapperFactory();
        configScript = new UpdateVaultWrapperConfig();

        (factory, timelock, beacon, impl, adapter) = deployScript.deploySystem(
            _config(multisig),
            deployerPk,
            "vw-test"
        );
    }

    function test_DeploySystem_WiresGovernance() public view {
        assertEq(beacon.owner(), address(timelock));
        assertEq(factory.owner(), address(timelock));
        assertEq(factory.BEACON(), address(beacon));
        assertEq(beacon.implementation(), address(impl));
        assertEq(impl.EXPECTED_FACTORY(), address(factory));

        assertEq(factory.emergencyPauser(), pauser);
        assertEq(factory.onboardingManager(), onboarder);
        assertEq(factory.lifiFeeRecipient(), lifiRecipient);

        assertGt(address(impl).code.length, 0);
        assertGt(address(adapter).code.length, 0);
    }

    function test_DeploySystem_WiresTimelockRoles() public view {
        assertEq(timelock.getMinDelay(), MIN_DELAY);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), multisig));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
    }

    function test_DeploySystem_IsIdempotentOnSameSalt() public {
        (
            LiFiVaultWrapperFactory factory2,
            TimelockController timelock2,
            UpgradeableBeacon beacon2,
            LiFiVaultWrapper impl2,
            ERC4626Adapter adapter2
        ) = deployScript.deploySystem(
                _config(multisig),
                deployerPk,
                "vw-test"
            );

        assertEq(address(factory2), address(factory));
        assertEq(address(timelock2), address(timelock));
        assertEq(address(beacon2), address(beacon));
        assertEq(address(impl2), address(impl));
        assertEq(address(adapter2), address(adapter));
    }

    function testRevert_DeploySystemOnZeroMultisig() public {
        vm.expectRevert(DeployLiFiVaultWrapperFactory.ZeroMultisig.selector);

        deployScript.deploySystem(_config(address(0)), deployerPk, "other");
    }

    function testRevert_DeploySystemWiringMismatchOnStaleRedeploy() public {
        // Re-running under the same salt after changing a role resolves the STALE
        // factory (CREATE3 salt excludes constructor args), so _verifyWiring must
        // catch that the live wiring no longer matches the corrected config.
        DeployLiFiVaultWrapperFactory.DeployConfig memory changed = _config(
            multisig
        );
        changed.emergencyPauser = makeAddr("newPauser");

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployLiFiVaultWrapperFactory.WiringMismatch.selector,
                "factory.emergencyPauser"
            )
        );

        deployScript.deploySystem(changed, deployerPk, "vw-test");
    }

    function test_ConfigBatch_SchedulesAndApplies() public {
        UpdateVaultWrapperConfig.Batch memory batch = configScript.buildBatch(
            factory,
            address(adapter),
            _desired()
        );

        // adapter + one underlying + 4 fee bounds + default split
        assertEq(batch.targets.length, 3 + FEE_TYPE_COUNT);
        assertEq(batch.delay, MIN_DELAY);

        vm.prank(multisig);
        timelock.scheduleBatch(
            batch.targets,
            batch.values,
            batch.payloads,
            batch.predecessor,
            batch.salt,
            batch.delay
        );

        vm.warp(block.timestamp + batch.delay + 1);

        timelock.executeBatch(
            batch.targets,
            batch.values,
            batch.payloads,
            batch.predecessor,
            batch.salt
        );

        assertTrue(factory.approvedAdapter(address(adapter)));
        assertTrue(factory.allowedUnderlying(underlying));
        assertEq(factory.defaultIntegratorShareBps(), TEST_SPLIT_BPS);

        (uint16 perfMin, uint16 perfMax) = factory.feeBounds(
            FeeType.Performance
        );
        assertEq(perfMin, 0);
        assertEq(perfMax, 5000);
    }

    function test_ConfigBatch_IsEmptyWhenInSync() public {
        UpdateVaultWrapperConfig.Batch memory batch = configScript.buildBatch(
            factory,
            address(adapter),
            _desired()
        );

        vm.prank(multisig);
        timelock.scheduleBatch(
            batch.targets,
            batch.values,
            batch.payloads,
            batch.predecessor,
            batch.salt,
            batch.delay
        );

        vm.warp(block.timestamp + batch.delay + 1);

        timelock.executeBatch(
            batch.targets,
            batch.values,
            batch.payloads,
            batch.predecessor,
            batch.salt
        );

        UpdateVaultWrapperConfig.Batch memory rerun = configScript.buildBatch(
            factory,
            address(adapter),
            _desired()
        );

        assertEq(rerun.targets.length, 0);
    }

    function test_CheckBpsAcceptsInRange() public view {
        assertEq(configScript.checkBps(7000, 9999), 7000);
        assertEq(configScript.checkBps(10000, 10000), 10000);
    }

    function testRevert_CheckBpsOnTruncatingValue() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateVaultWrapperConfig.BpsOutOfRange.selector,
                uint256(65536)
            )
        );

        configScript.checkBps(65536, 10000);
    }

    function testRevert_CheckBpsAboveMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UpdateVaultWrapperConfig.BpsOutOfRange.selector,
                uint256(10000)
            )
        );

        configScript.checkBps(10000, 9999);
    }

    function _config(
        address _multisig
    )
        internal
        view
        returns (DeployLiFiVaultWrapperFactory.DeployConfig memory cfg)
    {
        cfg.create3Factory = ICREATE3Factory(address(create3));
        cfg.multisig = _multisig;
        cfg.emergencyPauser = pauser;
        cfg.onboardingManager = onboarder;
        cfg.lifiFeeRecipient = lifiRecipient;
    }

    function _desired()
        internal
        view
        returns (UpdateVaultWrapperConfig.Desired memory d)
    {
        d.defaultIntegratorShareBps = TEST_SPLIT_BPS;
        d.feeMinBps = [uint16(0), 0, 0, 0];
        d.feeMaxBps = [uint16(5000), 1000, 2000, 2000];
        d.allowedUnderlyings = new address[](1);
        d.allowedUnderlyings[0] = underlying;
    }
}
