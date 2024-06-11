// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract OwnershipFacetTest is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    OwnershipFacet internal ownershipFacet;

    function setUp() public {
        diamond = createDiamond();
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

    function testFailNonOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        assert(ownershipFacet.owner() != newOwner);
        vm.prank(newOwner);
        ownershipFacet.transferOwnership(newOwner);
    }

    function testFailOnwershipTransferToNullAddr() public {
        address newOwner = address(0x0);
        ownershipFacet.transferOwnership(newOwner);
    }

    function testFailOwnerCanConfirmPendingOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        ownershipFacet.transferOwnership(newOwner);
        ownershipFacet.confirmOwnershipTransfer();
    }

    function testFailOwnershipTransferToSelf() public {
        address newOwner = address(this);
        ownershipFacet.transferOwnership(newOwner);
    }
}
