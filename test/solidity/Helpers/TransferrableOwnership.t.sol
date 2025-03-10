// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract TransferrableOwnershipTest is DSTest {
    TransferrableOwnership internal ownable;
    Vm internal immutable VM = Vm(HEVM_ADDRESS);

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
        VM.startPrank(newOwner);
        ownable.confirmOwnershipTransfer();
        assert(ownable.owner() == newOwner);
        VM.stopPrank();
    }

    function testRevert_NonOwnerCannotTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        assert(ownable.owner() != newOwner);

        VM.prank(newOwner);

        VM.expectRevert(UnAuthorized.selector);

        ownable.transferOwnership(newOwner);
    }

    function testRevert_CannotTransferOnwershipToNullAddr() public {
        address newOwner = address(0);

        VM.expectRevert(NoNullOwner.selector);

        ownable.transferOwnership(newOwner);
    }

    function testRevert_PendingOwnershipTransferCannotBeConfirmedByNonNewOwner()
        public
    {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        ownable.transferOwnership(newOwner);

        VM.expectRevert(NotPendingOwner.selector);

        ownable.confirmOwnershipTransfer();
    }

    function testRevert_CannotTransferOwnershipToSelf() public {
        address newOwner = address(this);

        VM.expectRevert(NewOwnerMustNotBeSelf.selector);

        ownable.transferOwnership(newOwner);
    }
}
