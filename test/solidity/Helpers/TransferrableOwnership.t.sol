// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract TransferrableOwnershipTest is DSTest {
    TransferrableOwnership internal ownable;
    // solhint-disable immutable-vars-naming
    Vm internal immutable vm = Vm(HEVM_ADDRESS);

    error NoNullOwner();
    error NewOwnerMustNotBeSelf();
    error NoPendingOwnershipTransfer();
    error NotPendingOwner();

    function setUp() public {
        ownable = new TransferrableOwnership(address(this));
    }

    function testOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        ownable.transferOwnership(newOwner);
        assert(ownable.owner() != newOwner);
        vm.startPrank(newOwner);
        ownable.confirmOwnershipTransfer();
        assert(ownable.owner() == newOwner);
        vm.stopPrank();
    }

    function testRevert_NonOwnerCannotTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        assert(ownable.owner() != newOwner);

        vm.prank(newOwner);

        vm.expectRevert(UnAuthorized.selector);

        ownable.transferOwnership(newOwner);
    }

    function testRevert_CannotTransferOnwershipToNullAddr() public {
        address newOwner = address(0);

        vm.expectRevert(NoNullOwner.selector);

        ownable.transferOwnership(newOwner);
    }

    function testRevert_PendingOwnershipTransferCannotBeConfirmedByNonNewOwner()
        public
    {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        ownable.transferOwnership(newOwner);

        vm.expectRevert(NotPendingOwner.selector);

        ownable.confirmOwnershipTransfer();
    }

    function testRevert_CannotTransferOwnershipToSelf() public {
        address newOwner = address(this);

        vm.expectRevert(NewOwnerMustNotBeSelf.selector);

        ownable.transferOwnership(newOwner);
    }

    function test_OwnerCanCancelOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        ownable.transferOwnership(newOwner);
        assertEq(ownable.pendingOwner(), newOwner);

        ownable.cancelOwnershipTransfer();
        assertEq(ownable.pendingOwner(), address(0));
    }

    function testRevert_CannotCancelWhenNoPendingTransfer() public {
        vm.expectRevert(NoPendingOwnershipTransfer.selector);
        ownable.cancelOwnershipTransfer();
    }
}
