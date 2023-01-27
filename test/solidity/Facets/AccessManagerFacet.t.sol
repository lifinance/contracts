// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { LibAccess } from "lifi/Libraries/LibAccess.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract RestrictedContract {
    function restrictedMethod() external view returns (bool) {
        LibAccess.enforceAccessControl();
        return true;
    }
}

contract AccessManagerFacetTest is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    AccessManagerFacet internal accessMgr;
    RestrictedContract internal restricted;

    function setUp() public {
        diamond = createDiamond();
        accessMgr = new AccessManagerFacet();
        restricted = new RestrictedContract();

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = accessMgr.setCanExecute.selector;
        addFacet(diamond, address(accessMgr), functionSelectors);

        functionSelectors[0] = restricted.restrictedMethod.selector;
        addFacet(diamond, address(restricted), functionSelectors);

        accessMgr = AccessManagerFacet(address(diamond));
        restricted = RestrictedContract(address(diamond));
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
