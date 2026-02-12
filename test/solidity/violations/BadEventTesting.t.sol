// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

contract BadEventTesting is Test {
    event SomeEvent(address indexed user, uint256 amount);
    
    function setUp() public {
        // Minimal setup but missing initTestBase()
    }
    
    function test_EventEmission() public {
        address user = address(0x123);
        uint256 amount = 100;
        
        // VIOLATION: vm.expectEmit should have blank line before it
        vm.expectEmit(true, true, true, true, address(this));
        // VIOLATION: Should not have blank line between expectEmit and event
        
        emit SomeEvent(user, amount);
        
        // VIOLATION: No blank line after vm.expectEmit block
        uint256 result = 42;
        
        // VIOLATION: Missing blank line before assertions
        assertEq(result, 42);
    }
    
    // VIOLATION: No blank line between test functions
    function testRevert_WithoutSpecificError() public {
        // VIOLATION: Should use specific error with vm.expectRevert
        vm.expectRevert();
        revert("Some error");
    }
}
