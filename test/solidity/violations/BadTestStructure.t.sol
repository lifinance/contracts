// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// VIOLATION: Import ordering incorrect (should be system libs first, then project)
import { LiFiData } from "lifi/Helpers/LiFiData.sol";
import { Test } from "forge-std/Test.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

// VIOLATION: Should inherit from TestBaseFacet for facet tests
contract BadTestStructure is Test {
    address internal user;
    address internal receiver;
    
    // VIOLATION: Missing setUp() function - tests require setUp()
    
    // VIOLATION: Function naming - should be test_, testRevert_, or testBase_
    function testSomething() public {
        // VIOLATION: No vm.label for actors
        user = address(0x123);
        receiver = address(0x456);
        
        // VIOLATION: Missing initTestBase() call
        
        // Test logic here
        assertEq(user, address(0x123));
    }
    
    // VIOLATION: No blank line before assertions, incorrect revert testing
    function testRevertScenario() public {
        address badAddress = address(0);
        // VIOLATION: Should use vm.expectRevert with specific error
        // VIOLATION: No blank line between vm.expectRevert and function call
        vm.expectRevert();
        revert("Generic error");
    }
    
    // VIOLATION: Missing blank lines around logical blocks
    function anotherTest() public {
        address actor = address(0x789);
        vm.startPrank(actor);
        // VIOLATION: No blank line after vm.startPrank
        uint256 value = 100;
        assertEq(value, 100);
        // VIOLATION: No blank line before vm.stopPrank
        vm.stopPrank();
    }
    
    // VIOLATION: No blank line between test functions
    function yetAnotherTest() public {
        // VIOLATION: Missing blank line before assertions
        assertEq(1, 1);
        assertEq(2, 2);
    }
}
