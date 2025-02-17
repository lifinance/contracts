// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { LibAllowList, LibSwap, TestBase, console, LiFiDiamond } from "../utils/TestBase.sol";
import { OnlyContractOwner } from "lifi/Errors/GenericErrors.sol";

contract OwnershipFacetTest is TestBase {
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
        initTestBase();

        ownershipFacet = OwnershipFacet(address(diamond));
    }

    function test_OwnerCanTransferOwnership() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address newOwner = address(0x1234567890123456789012345678901234567890);

        vm.expectEmit(true, true, true, true, address(ownershipFacet));
        emit OwnershipTransferRequested(address(this), newOwner);

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

        ownershipFacet.transferOwnership(newOwner);

        assert(ownershipFacet.owner() != newOwner);

        ownershipFacet.cancelOwnershipTransfer();

        assert(ownershipFacet.owner() != newOwner);
    }

    function testRevert_NonOwnerCannotCancelOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        ownershipFacet.transferOwnership(newOwner);

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

        vm.expectRevert(NoNullOwner.selector);

        ownershipFacet.transferOwnership(newOwner);
    }

    function testRevert_PendingOwnershipTransferCannotBeConfirmedByNonNewOwner()
        public
    {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        ownershipFacet.transferOwnership(newOwner);

        vm.expectRevert(NotPendingOwner.selector);

        ownershipFacet.confirmOwnershipTransfer();
    }

    function testRevert_CannotTransferOwnershipToSelf() public {
        address newOwner = address(this);

        vm.expectRevert(NewOwnerMustNotBeSelf.selector);

        ownershipFacet.transferOwnership(newOwner);
    }
}
