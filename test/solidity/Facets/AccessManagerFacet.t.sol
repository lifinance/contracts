// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { UnAuthorized, CannotAuthoriseSelf, OnlyContractOwner } from "lifi/Errors/GenericErrors.sol";
import { TestBase, LibAccess, console, LiFiDiamond } from "../utils/TestBase.sol";

contract RestrictedContract {
    function restrictedMethod() external view returns (bool) {
        LibAccess.enforceAccessControl();
        return true;
    }
}

contract AccessManagerFacetTest is TestBase {
    AccessManagerFacet internal accessMgr;
    RestrictedContract internal restricted;

    function setUp() public {
        initTestBase();

        accessMgr = new AccessManagerFacet();
        restricted = new RestrictedContract();

        bytes4[] memory allowedFunctionSelectors = new bytes4[](2);
        allowedFunctionSelectors[0] = accessMgr.setCanExecute.selector;
        allowedFunctionSelectors[1] = accessMgr
            .addressCanExecuteMethod
            .selector;
        addFacet(diamond, address(accessMgr), allowedFunctionSelectors);

        bytes4[] memory restrictedFunctionSelectors = new bytes4[](1);
        restrictedFunctionSelectors[0] = restricted.restrictedMethod.selector;
        addFacet(diamond, address(restricted), restrictedFunctionSelectors);

        accessMgr = AccessManagerFacet(address(diamond));
        restricted = RestrictedContract(address(diamond));

        // set facet address in TestBase
        setFacetAddressInTestBase(address(accessMgr), "AccessManagerFacet");
    }

    function testAccessIsRestricted() public {
        vm.expectRevert(UnAuthorized.selector);

        vm.prank(address(0xb33f));
        restricted.restrictedMethod();
    }

    function testCanGrantAccess() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );

        vm.stopPrank();

        vm.prank(address(0xb33f));
        restricted.restrictedMethod();
    }

    function testCanRemoveAccess() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );
        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            false
        );

        vm.stopPrank();

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(address(0xb33f));
        restricted.restrictedMethod();
    }

    function testRevert_CannotAuthorizeSelf() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(CannotAuthoriseSelf.selector);

        accessMgr.setCanExecute(
            AccessManagerFacet.setCanExecute.selector,
            address(accessMgr),
            true
        );

        vm.stopPrank();
    }

    function testRevert_IfNotContractOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);

        accessMgr.setCanExecute(
            AccessManagerFacet.setCanExecute.selector,
            address(0xb33f),
            true
        );

        vm.stopPrank();
    }

    function testDefaultAccessIsFalse() public {
        bool canExecute = accessMgr.addressCanExecuteMethod(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f)
        );

        assertEq(canExecute, false, "Default access should be false");
    }

    function testCanCheckGrantedAccess() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );

        bool canExecute = accessMgr.addressCanExecuteMethod(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f)
        );

        assertEq(canExecute, true, "Access should be granted");

        vm.stopPrank();
    }

    function testCanCheckRevokedAccess() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            false
        );

        bool canExecute = accessMgr.addressCanExecuteMethod(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f)
        );

        assertEq(canExecute, false, "Access should be revoked");

        vm.stopPrank();
    }

    function testDifferentMethodSelectorReturnsFalse() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );

        bool canExecute = accessMgr.addressCanExecuteMethod(
            bytes4(keccak256("anotherMethod()")),
            address(0xb33f)
        );

        assertEq(
            canExecute,
            false,
            "Different method selector should return false"
        );

        vm.stopPrank();
    }

    function testDifferentExecutorReturnsFalse() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );

        bool canExecute = accessMgr.addressCanExecuteMethod(
            RestrictedContract.restrictedMethod.selector,
            address(0xcafe)
        );

        assertEq(canExecute, false, "Different executor should return false");

        vm.stopPrank();
    }
}
