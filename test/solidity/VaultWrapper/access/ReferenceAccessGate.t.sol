// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ReferenceAccessGate } from "lifi/VaultWrapper/access/ReferenceAccessGate.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";

contract ReferenceAccessGateTest is Test {
    ReferenceAccessGate internal gate;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event AllowlistedSet(address indexed account, bool allowed);
    event DenylistedSet(address indexed account, bool denied);
    event SanctionedSet(address indexed account, bool flagged);
    event AllowlistEnabledSet(bool enabled);

    function setUp() public {
        gate = new ReferenceAccessGate(owner, false);
    }

    /// Permissionless default ///

    function test_PermissionlessWhenAllowlistDisabled() public view {
        assertTrue(gate.isAllowed(alice));
        assertTrue(gate.isTransferable(alice, bob));
        assertFalse(gate.isSanctioned(alice));
    }

    /// Allowlist ///

    function test_AllowlistBlocksUnlistedWhenEnabled() public {
        vm.prank(owner);
        gate.setAllowlistEnabled(true);

        assertFalse(gate.isAllowed(alice));

        vm.prank(owner);
        gate.setAllowlisted(alice, true);
        assertTrue(gate.isAllowed(alice));
    }

    function test_AllowlistBatchSetsMany() public {
        vm.startPrank(owner);
        gate.setAllowlistEnabled(true);
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        gate.setAllowlistedBatch(accounts, true);
        vm.stopPrank();

        assertTrue(gate.isAllowed(alice));
        assertTrue(gate.isAllowed(bob));
    }

    /// Denylist ///

    function test_DenylistBlocksEvenWhenPermissionless() public {
        vm.prank(owner);
        gate.setDenylisted(alice, true);

        assertFalse(gate.isAllowed(alice));
        assertFalse(gate.isTransferable(alice, bob));
    }

    function test_DenylistOverridesAllowlist() public {
        vm.startPrank(owner);
        gate.setAllowlistEnabled(true);
        gate.setAllowlisted(alice, true);
        gate.setDenylisted(alice, true);
        vm.stopPrank();

        assertFalse(gate.isAllowed(alice));
    }

    /// Sanctions (exit freeze) ///

    function test_SanctionFlagFreezesEntryAndTransferButIsReported() public {
        vm.prank(owner);
        gate.setSanctioned(alice, true);

        assertTrue(gate.isSanctioned(alice));
        assertFalse(gate.isAllowed(alice));
        assertFalse(gate.isTransferable(alice, bob));
    }

    function test_SanctionBatchSetsMany() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;

        vm.prank(owner);
        gate.setSanctionedBatch(accounts, true);

        assertTrue(gate.isSanctioned(alice));
        assertTrue(gate.isSanctioned(bob));
    }

    /// Transferability perimeter ///

    function test_TransferRequiresBothEndpointsAllowed() public {
        vm.startPrank(owner);
        gate.setAllowlistEnabled(true);
        gate.setAllowlisted(alice, true);
        vm.stopPrank();

        assertFalse(gate.isTransferable(alice, bob));

        vm.prank(owner);
        gate.setAllowlisted(bob, true);
        assertTrue(gate.isTransferable(alice, bob));
    }

    /// Ownership ///

    function test_RevertWhen_NonOwnerConfigures() public {
        vm.prank(alice);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);
        gate.setAllowlisted(bob, true);
    }

    /// Events ///

    function test_EmitsOnConfiguration() public {
        vm.startPrank(owner);

        vm.expectEmit(true, false, false, true, address(gate));
        emit AllowlistEnabledSet(true);
        gate.setAllowlistEnabled(true);

        vm.expectEmit(true, false, false, true, address(gate));
        emit AllowlistedSet(alice, true);
        gate.setAllowlisted(alice, true);

        vm.expectEmit(true, false, false, true, address(gate));
        emit DenylistedSet(bob, true);
        gate.setDenylisted(bob, true);

        vm.expectEmit(true, false, false, true, address(gate));
        emit SanctionedSet(bob, true);
        gate.setSanctioned(bob, true);

        vm.stopPrank();
    }
}
