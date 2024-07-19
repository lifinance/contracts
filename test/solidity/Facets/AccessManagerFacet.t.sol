// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";
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

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = accessMgr.setCanExecute.selector;
        addFacet(diamond, address(accessMgr), functionSelectors);

        functionSelectors[0] = restricted.restrictedMethod.selector;
        addFacet(diamond, address(restricted), functionSelectors);

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
        accessMgr.setCanExecute(
            RestrictedContract.restrictedMethod.selector,
            address(0xb33f),
            true
        );
        vm.prank(address(0xb33f));
        restricted.restrictedMethod();
    }

    function testCanRemoveAccess() public {
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
        vm.expectRevert(UnAuthorized.selector);
        vm.prank(address(0xb33f));
        restricted.restrictedMethod();
    }
}
