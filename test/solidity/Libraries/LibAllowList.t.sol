// SPDX-License-Identifier: LGPL-3.0-only
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
        LibAllowList.addAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)));

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 1);
        assertEq(allowedContracts[0], address(testContract));

        // Remove contract from allow list
        LibAllowList.removeAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)));

        allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 0);
    }

    function test_SucceedsIfRemovingNonExistentContract() public {
        // Try to remove a contract that was never added
        LibAllowList.removeAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)));

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 0);
    }

    function test_SucceedsIfAddingAndRemovingMultipleContracts() public {
        TestContract testContract2 = new TestContract();
        TestContract testContract3 = new TestContract();

        // Add multiple contracts
        LibAllowList.addAllowedContractSelector(address(testContract), TEST_SELECTOR);
        LibAllowList.addAllowedContractSelector(address(testContract2), TEST_SELECTOR);
        LibAllowList.addAllowedContractSelector(address(testContract3), TEST_SELECTOR);

        // Remove middle contract
        LibAllowList.removeAllowedContractSelector(address(testContract2), TEST_SELECTOR);

        address[] memory allowedContracts = LibAllowList.getAllowedContracts();
        assertEq(allowedContracts.length, 2);
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)));
        assertFalse(LibAllowList.contractIsAllowed(address(testContract2)));
        assertTrue(LibAllowList.contractIsAllowed(address(testContract3)));
    }

    function test_SucceedsIfAddingAndRemovingSelector() public {
        // Add selector to allow list
        LibAllowList.addAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertTrue(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 1);
        assertEq(allowedSelectors[0], TEST_SELECTOR);

        // Remove selector from allow list
        LibAllowList.removeAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertFalse(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 0);
    }

    function test_SucceedsIfRemovingNonExistentSelector() public {
        // Try to remove a selector that was never added
        LibAllowList.removeAllowedContractSelector(address(testContract), TEST_SELECTOR);
        assertFalse(LibAllowList.selectorIsAllowed(TEST_SELECTOR));

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 0);
    }

    function test_SucceedsIfAddingAndRemovingMultipleSelectors() public {
        bytes4 selector2 = bytes4(keccak256("test2()"));
        bytes4 selector3 = bytes4(keccak256("test3()"));

        // Add multiple selectors
        LibAllowList.addAllowedContractSelector(address(testContract), TEST_SELECTOR);
        LibAllowList.addAllowedContractSelector(address(testContract), selector2);
        LibAllowList.addAllowedContractSelector(address(testContract), selector3);

        // Remove middle selector
        LibAllowList.removeAllowedContractSelector(address(testContract), selector2);

        bytes4[] memory allowedSelectors = LibAllowList.getAllowedSelectors();
        assertEq(allowedSelectors.length, 2);
        assertTrue(LibAllowList.selectorIsAllowed(TEST_SELECTOR));
        assertFalse(LibAllowList.selectorIsAllowed(selector2));
        assertTrue(LibAllowList.selectorIsAllowed(selector3));
    }
}
