// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

// VIOLATION: For facet tests, should inherit from TestBaseFacet
// VIOLATION: Not calling initTestBase() in setUp
contract MissingTestBase is Test {
    address internal diamond;
    address internal user;
    
    function setUp() public {
        // VIOLATION: Missing initTestBase() call when inheriting from TestBase
        diamond = address(0x1111);
        user = address(0x2222);
        // VIOLATION: Missing vm.label calls for actors
    }
    
    // VIOLATION: Function name doesn't follow convention (should be test_)
    function checkSomething() public {
        assertEq(diamond, address(0x1111));
    }
    
    function test_ValidTest() public {
        vm.startPrank(user);
        // No blank line after startPrank (violation)
        uint256 balance = 1000;
        // No blank line before assertion (violation)
        assertEq(balance, 1000);
        vm.stopPrank();
    }
}
