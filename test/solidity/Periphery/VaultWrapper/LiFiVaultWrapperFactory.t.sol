// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/Periphery/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/Periphery/VaultWrapper/mocks/MockVaultWrapper.sol";
import { FeeType } from "lifi/Periphery/VaultWrapper/LiFiVaultWrapperTypes.sol";
import { UnAuthorized, InvalidConfig } from "lifi/Errors/GenericErrors.sol";

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

    function test_OwnerSetsUnderlyingAllowed() public {
        address u = makeAddr("underlying");
        vm.expectEmit(true, false, false, true, address(factory));
        emit LiFiVaultWrapperFactory.UnderlyingAllowedSet(u, true);
        vm.prank(owner);
        factory.setUnderlyingAllowed(u, true);
        assertTrue(factory.allowedUnderlying(u));
    }

    function test_NonOwnerCannotSetUnderlyingAllowed() public {
        vm.expectRevert(UnAuthorized.selector);
        factory.setUnderlyingAllowed(makeAddr("underlying"), true);
    }

    function test_OwnerSetsFeeBounds() public {
        vm.prank(owner);
        factory.setFeeBounds(FeeType.Performance, 100, 4000);
        (uint16 minBps, uint16 maxBps) = factory.feeBounds(
            FeeType.Performance
        );
        assertEq(minBps, 100);
        assertEq(maxBps, 4000);
    }

    function test_SetFeeBoundsRevertsAboveCap() public {
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        factory.setFeeBounds(FeeType.Performance, 0, 6000); // cap is 5000
    }

    function test_SetFeeBoundsRevertsMinAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        factory.setFeeBounds(FeeType.Deposit, 500, 100);
    }

    function test_OwnerSetsDefaultSplit() public {
        vm.prank(owner);
        factory.setDefaultSplit(FeeType.Management, 3000);
        assertEq(factory.defaultLifiShareBps(FeeType.Management), 3000);
    }

    function test_OnboardingManagerApprovesIntegrator() public {
        vm.prank(onboarder);
        factory.setIntegratorApproved(integrator, true);
        assertTrue(factory.approvedIntegrator(integrator));
    }

    function test_NonOnboardingManagerCannotApprove() public {
        vm.prank(owner);
        vm.expectRevert(UnAuthorized.selector);
        factory.setIntegratorApproved(integrator, true);
    }

    function test_EmergencyPauserTogglesGlobalPause() public {
        vm.prank(pauser);
        factory.globalPause();
        assertTrue(factory.isGlobalPaused());
        vm.prank(pauser);
        factory.globalUnpause();
        assertFalse(factory.isGlobalPaused());
    }

    function test_NonPauserCannotGlobalPause() public {
        vm.prank(owner);
        vm.expectRevert(UnAuthorized.selector);
        factory.globalPause();
    }

    function test_OwnerRotatesRoles() public {
        address newPauser = makeAddr("newPauser");
        vm.prank(owner);
        factory.setEmergencyPauser(newPauser);
        assertEq(factory.emergencyPauser(), newPauser);

        vm.prank(pauser);
        vm.expectRevert(UnAuthorized.selector);
        factory.globalPause(); // old pauser lost power
    }

    function test_OwnerRotatesOnboardingManager() public {
        address newManager = makeAddr("newManager");
        vm.prank(owner);
        factory.setOnboardingManager(newManager);
        assertEq(factory.onboardingManager(), newManager);

        vm.prank(onboarder);
        vm.expectRevert(UnAuthorized.selector);
        factory.setIntegratorApproved(integrator, true); // old manager lost power
    }
}
