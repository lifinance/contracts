// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";

contract TestContract {
    // Empty contract for testing
}

contract LibAllowListTest is Test {
    using LibAllowList for *;

    TestContract public testContract;
    bytes4 public constant TEST_SELECTOR = bytes4(keccak256("test()"));

    function setUp() public {
        testContract = new TestContract();
    }

    function test_SucceedsIfOwnerAddsAndRemovesContract() public {
        // Add contract to allow list
        LibAllowList.addAllowedContract(address(testContract));
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)));

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 1);
        assertEq(allowedContracts[0], address(testContract));

        // Remove contract from allow list
        LibAllowList.removeAllowedContract(address(testContract));
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)));

        allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 0);
    }

    function test_SucceedsIfRemovingNonExistentContract() public {
        // Try to remove a contract that was never added
        LibAllowList.removeAllowedContract(address(testContract));
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)));

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 0);
    }

    function test_SucceedsIfAddingAndRemovingMultipleContracts() public {
        TestContract testContract2 = new TestContract();
        TestContract testContract3 = new TestContract();

        // Add multiple contracts
        LibAllowList.addAllowedContract(address(testContract));
        LibAllowList.addAllowedContract(address(testContract2));
        LibAllowList.addAllowedContract(address(testContract3));

        // Remove middle contract
        LibAllowList.removeAllowedContract(address(testContract2));

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 2);
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)));
        assertFalse(LibAllowList.contractIsAllowed(address(testContract2)));
        assertTrue(LibAllowList.contractIsAllowed(address(testContract3)));
    }

    function test_SucceedsIfAddingAndRemovingSelector() public {
        // Add selector to allow list
        LibAllowList.addAllowedSelector(TEST_SELECTOR);
        assertTrue(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 1);
        assertEq(allowedSelectors[0], TEST_SELECTOR);

        // Remove selector from allow list
        LibAllowList.removeAllowedSelector(TEST_SELECTOR);
        assertFalse(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 0);
    }

    function test_SucceedsIfRemovingNonExistentSelector() public {
        // Try to remove a selector that was never added
        LibAllowList.removeAllowedSelector(TEST_SELECTOR);
        assertFalse(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 0);
    }

    function test_SucceedsIfAddingAndRemovingMultipleSelectors() public {
        bytes4 selector2 = bytes4(keccak256("test2()"));
        bytes4 selector3 = bytes4(keccak256("test3()"));

        // Add multiple selectors
        LibAllowList.addAllowedSelector(TEST_SELECTOR);
        LibAllowList.addAllowedSelector(selector2);
        LibAllowList.addAllowedSelector(selector3);

        // Remove middle selector
        LibAllowList.removeAllowedSelector(selector2);

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 2);
        assertTrue(LibAllowList.selectorIsAllowed(TEST_SELECTOR));
        assertFalse(LibAllowList.selectorIsAllowed(selector2));
        assertTrue(LibAllowList.selectorIsAllowed(selector3));
    }
}
