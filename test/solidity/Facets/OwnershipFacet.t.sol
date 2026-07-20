// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { TestBaseLocal } from "../utils/TestBaseLocal.sol";
import { OnlyContractOwner } from "lifi/Errors/GenericErrors.sol";

contract OwnershipFacetTest is TestBaseLocal {
    OwnershipFacet internal ownershipFacet;

    error NoNullOwner();
    error NewOwnerMustNotBeSelf();
    error NoPendingOwnershipTransfer();
    error NotPendingOwner();

    event OwnershipTransferRequested(
        address indexed _from,
        address indexed _to
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    function setUp() public {
        initTestBaseLocal();

        ownershipFacet = OwnershipFacet(address(diamond));
    }

    function test_OwnerCanTransferOwnership() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address newOwner = address(0x1234567890123456789012345678901234567890);

        vm.expectEmit(true, true, true, true, address(ownershipFacet));
        emit OwnershipTransferRequested(USER_DIAMOND_OWNER, newOwner);

        ownershipFacet.transferOwnership(newOwner);

        assert(ownershipFacet.owner() != newOwner);

        vm.stopPrank();
        vm.startPrank(newOwner);

        vm.expectEmit(true, true, true, true, address(ownershipFacet));
        emit OwnershipTransferred(address(USER_DIAMOND_OWNER), newOwner);

        ownershipFacet.confirmOwnershipTransfer();

        assert(ownershipFacet.owner() == newOwner);

        vm.stopPrank();
    }

    function testRevert_CannotCancelNonPendingOwnershipTransfer() public {
        assert(ownershipFacet.owner() == USER_DIAMOND_OWNER);
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(NoPendingOwnershipTransfer.selector);

        ownershipFacet.cancelOwnershipTransfer();

        assert(ownershipFacet.owner() == USER_DIAMOND_OWNER);

        vm.stopPrank();
    }

    function test_OwnerCanCancelOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        vm.startPrank(USER_DIAMOND_OWNER);

        ownershipFacet.transferOwnership(newOwner);

        assert(ownershipFacet.owner() != newOwner);

        ownershipFacet.cancelOwnershipTransfer();

        assert(ownershipFacet.owner() != newOwner);

        vm.stopPrank();
    }

    function testRevert_NonOwnerCannotCancelOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        vm.startPrank(USER_DIAMOND_OWNER);
        ownershipFacet.transferOwnership(newOwner);
        vm.stopPrank();

        assert(ownershipFacet.owner() != newOwner);

        vm.startPrank(newOwner);

        vm.expectRevert(OnlyContractOwner.selector);

        ownershipFacet.cancelOwnershipTransfer();

        assert(ownershipFacet.owner() != newOwner);

        vm.stopPrank();
    }

    function testRevert_NonOwnerCannotTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        assert(ownershipFacet.owner() != newOwner);
        vm.prank(newOwner);

        vm.expectRevert(OnlyContractOwner.selector);

        ownershipFacet.transferOwnership(newOwner);
    }

    function testRevert_CannotTransferOnwershipToNullAddr() public {
        address newOwner = address(0);

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(NoNullOwner.selector);

        ownershipFacet.transferOwnership(newOwner);

        vm.stopPrank();
    }

    function testRevert_PendingOwnershipTransferCannotBeConfirmedByNonNewOwner()
        public
    {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        vm.startPrank(USER_DIAMOND_OWNER);
        ownershipFacet.transferOwnership(newOwner);
        vm.stopPrank();

        vm.expectRevert(NotPendingOwner.selector);

        ownershipFacet.confirmOwnershipTransfer();
    }

    function testRevert_CannotTransferOwnershipToSelf() public {
        address newOwner = USER_DIAMOND_OWNER;

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(NewOwnerMustNotBeSelf.selector);

        ownershipFacet.transferOwnership(newOwner);

        vm.stopPrank();
    }
}
