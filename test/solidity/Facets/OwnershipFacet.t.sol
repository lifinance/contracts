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

    function setUp() public {
        initTestBase();

        ownershipFacet = OwnershipFacet(address(diamond));
    }

    function testOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);

        ownershipFacet.transferOwnership(newOwner);

        assert(ownershipFacet.owner() != newOwner);

        vm.startPrank(newOwner);

        ownershipFacet.confirmOwnershipTransfer();

        assert(ownershipFacet.owner() == newOwner);

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
