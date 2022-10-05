// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";

contract TransferrableOwnershipTest is DSTest {
    TransferrableOwnership internal ownable;
    Vm internal immutable vm = Vm(HEVM_ADDRESS);

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

    function testFailNonOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        assert(ownable.owner() != newOwner);
        vm.prank(newOwner);
        ownable.transferOwnership(newOwner);
    }

    function testFailOnwershipTransferToNullAddr() public {
        address newOwner = address(0x0);
        ownable.transferOwnership(newOwner);
    }

    function testFailOwnerCanConfirmPendingOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        ownable.transferOwnership(newOwner);
        ownable.confirmOwnershipTransfer();
    }

    function testFailOwnershipTransferToSelf() public {
        address newOwner = address(this);
        ownable.transferOwnership(newOwner);
    }
}
