// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/Periphery/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/Periphery/VaultWrapper/mocks/MockVaultWrapper.sol";
import { FeeType } from "lifi/Periphery/VaultWrapper/LiFiVaultWrapperTypes.sol";

contract LiFiVaultWrapperFactoryTest is Test {
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    MockVaultWrapper internal impl;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal integrator = makeAddr("integrator");

    function setUp() public virtual {
        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            pauser,
            onboarder
        );
    }

    function test_ConstructorSetsRolesBeaconAndDefaultSplit() public view {
        assertEq(factory.beacon(), address(beacon));
        assertEq(factory.owner(), owner);
        assertEq(factory.emergencyPauser(), pauser);
        assertEq(factory.onboardingManager(), onboarder);
        for (uint8 i; i < 4; ++i) {
            assertEq(factory.defaultLifiShareBps(FeeType(i)), 2000);
        }
        assertFalse(factory.globalPaused());
    }

    function test_ConstructorRevertsOnZeroBeacon() public {
        vm.expectRevert();
        new LiFiVaultWrapperFactory(address(0), owner, pauser, onboarder);
    }
}
