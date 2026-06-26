// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ReferenceAccessControl } from "lifi/VaultWrapper/access/ReferenceAccessControl.sol";
import { ISanctionsOracle } from "lifi/VaultWrapper/interfaces/ISanctionsOracle.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";

/// @notice Minimal sanctions oracle whose flags can be toggled per account.
contract MockSanctionsOracle is ISanctionsOracle {
    mapping(address => bool) public flagged;

    function setSanctioned(address _account, bool _sanctioned) external {
        flagged[_account] = _sanctioned;
    }

    function isSanctioned(
        address _account
    ) external view returns (bool sanctioned) {
        return flagged[_account];
    }
}

contract ReferenceAccessControlTest is Test {
    ReferenceAccessControl internal access;
    MockSanctionsOracle internal oracle;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    event AllowlistedSet(address indexed account, bool allowed);
    event DenylistedSet(address indexed account, bool denied);
    event AllowlistEnabledSet(bool enabled);
    event SanctionsOracleSet(address indexed oracle);

    function setUp() public {
        oracle = new MockSanctionsOracle();
        access = new ReferenceAccessControl(owner, false, address(0));
    }

    /// Construction ///

    function test_ConstructorSetsConfiguration() public {
        ReferenceAccessControl a = new ReferenceAccessControl(
            owner,
            true,
            address(oracle)
        );

        assertEq(a.owner(), owner);
        assertTrue(a.allowlistEnabled());
        assertEq(address(a.sanctionsOracle()), address(oracle));
    }

    /// Denylist semantics ///

    function test_DenylistDeniesAndBlocksAllowance() public {
        vm.prank(owner);
        access.setDenylisted(mallory, true);

        assertTrue(access.isDenied(mallory));
        assertFalse(access.isAllowed(mallory));
    }

    function test_DeniedAccountStaysDeniedEvenWhenAllowlisted() public {
        vm.startPrank(owner);
        access.setAllowlistEnabled(true);
        access.setAllowlisted(mallory, true);
        access.setDenylisted(mallory, true);
        vm.stopPrank();

        assertTrue(access.isDenied(mallory));
        assertFalse(access.isAllowed(mallory));
    }

    /// Allowlist semantics ///

    function test_AllowlistDisabledAllowsEveryNonDeniedAccount() public view {
        assertFalse(access.allowlistEnabled());
        assertTrue(access.isAllowed(alice));
        assertTrue(access.isAllowed(bob));
    }

    function test_AllowlistEnabledOnlyAllowsListedAccounts() public {
        vm.startPrank(owner);
        access.setAllowlistEnabled(true);
        access.setAllowlisted(alice, true);
        vm.stopPrank();

        assertTrue(access.isAllowed(alice));
        assertFalse(access.isAllowed(bob));
    }

    /// Sanctions oracle ///

    function test_SanctionedAccountIsDenied() public {
        vm.prank(owner);
        access.setSanctionsOracle(address(oracle));
        oracle.setSanctioned(mallory, true);

        assertTrue(access.isDenied(mallory));
        assertFalse(access.isAllowed(mallory));
    }

    function test_SanctionsIgnoredWhenOracleUnset() public {
        oracle.setSanctioned(mallory, true);

        // Default adapter has no oracle wired, so sanctions are not consulted.
        assertFalse(access.isDenied(mallory));
        assertTrue(access.isAllowed(mallory));
    }

    function test_ClearingOracleStopsScreening() public {
        vm.prank(owner);
        access.setSanctionsOracle(address(oracle));
        oracle.setSanctioned(mallory, true);
        assertTrue(access.isDenied(mallory));

        vm.prank(owner);
        access.setSanctionsOracle(address(0));

        assertFalse(access.isDenied(mallory));
    }

    function test_SanctionedAccountDeniedEvenWhenAllowlisted() public {
        vm.startPrank(owner);
        access.setSanctionsOracle(address(oracle));
        access.setAllowlistEnabled(true);
        access.setAllowlisted(mallory, true);
        vm.stopPrank();
        oracle.setSanctioned(mallory, true);

        assertFalse(access.isAllowed(mallory));
    }

    /// Batch setters ///

    function test_BatchAllowlistAndDenylist() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;

        vm.startPrank(owner);
        access.setAllowlistEnabled(true);
        access.setAllowlistedBatch(accounts, true);
        vm.stopPrank();

        assertTrue(access.isAllowed(alice));
        assertTrue(access.isAllowed(bob));

        vm.prank(owner);
        access.setDenylistedBatch(accounts, true);

        assertTrue(access.isDenied(alice));
        assertTrue(access.isDenied(bob));
    }

    function test_BatchSettersAreNoOpForEmptyArray() public {
        address[] memory empty = new address[](0);

        vm.startPrank(owner);
        access.setAllowlistedBatch(empty, true);
        access.setDenylistedBatch(empty, true);
        vm.stopPrank();

        assertFalse(access.allowlisted(alice));
        assertFalse(access.denylisted(alice));
    }

    function test_BatchSettersEmitPerElementEvents() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;

        vm.expectEmit(true, true, true, true);
        emit AllowlistedSet(alice, true);
        vm.expectEmit(true, true, true, true);
        emit AllowlistedSet(bob, true);

        vm.prank(owner);
        access.setAllowlistedBatch(accounts, true);
    }

    /// Toggle-off direction ///

    function test_RemovingFromAllowlistRegatesAccount() public {
        vm.startPrank(owner);
        access.setAllowlistEnabled(true);
        access.setAllowlisted(alice, true);
        assertTrue(access.isAllowed(alice));

        access.setAllowlisted(alice, false);
        vm.stopPrank();

        assertFalse(access.allowlisted(alice));
        assertFalse(access.isAllowed(alice));
    }

    function test_RemovingFromDenylistRestoresAllowance() public {
        vm.startPrank(owner);
        access.setDenylisted(alice, true);
        assertTrue(access.isDenied(alice));

        access.setDenylisted(alice, false);
        vm.stopPrank();

        assertFalse(access.isDenied(alice));
        assertTrue(access.isAllowed(alice));
    }

    function test_DisablingAllowlistReopensGatedAccount() public {
        vm.startPrank(owner);
        access.setAllowlistEnabled(true);
        assertFalse(access.isAllowed(bob));

        access.setAllowlistEnabled(false);
        vm.stopPrank();

        assertTrue(access.isAllowed(bob));
    }

    /// Events ///

    function test_SettersEmitEvents() public {
        vm.startPrank(owner);

        vm.expectEmit(true, true, true, true);
        emit AllowlistedSet(alice, true);
        access.setAllowlisted(alice, true);

        vm.expectEmit(true, true, true, true);
        emit DenylistedSet(bob, true);
        access.setDenylisted(bob, true);

        vm.expectEmit(true, true, true, true);
        emit AllowlistEnabledSet(true);
        access.setAllowlistEnabled(true);

        vm.expectEmit(true, true, true, true);
        emit SanctionsOracleSet(address(oracle));
        access.setSanctionsOracle(address(oracle));

        vm.stopPrank();
    }

    /// Access control ///

    function testRevert_NonOwnerCannotSetAllowlisted() public {
        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setAllowlisted(alice, true);
    }

    function testRevert_NonOwnerCannotSetAllowlistedBatch() public {
        address[] memory accounts = new address[](1);
        accounts[0] = alice;

        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setAllowlistedBatch(accounts, true);
    }

    function testRevert_NonOwnerCannotSetDenylisted() public {
        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setDenylisted(alice, true);
    }

    function testRevert_NonOwnerCannotSetDenylistedBatch() public {
        address[] memory accounts = new address[](1);
        accounts[0] = alice;

        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setDenylistedBatch(accounts, true);
    }

    function testRevert_NonOwnerCannotSetAllowlistEnabled() public {
        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setAllowlistEnabled(true);
    }

    function testRevert_NonOwnerCannotSetSanctionsOracle() public {
        vm.prank(mallory);
        vm.expectRevert(TransferrableOwnership.UnAuthorized.selector);

        access.setSanctionsOracle(address(oracle));
    }
}
