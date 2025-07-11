// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";
import { InvalidContract } from "../../../src/Errors/GenericErrors.sol";

contract TestContract {
    // Empty contract for testing
}

contract DummyContract1 {
    // Throwaway contract for testing
}

contract DummyContract2 {
    // Throwaway contract for testing
}

contract DummyContract3 {
    // Throwaway contract for testing
}

contract LibAllowListTest is Test {
    using LibAllowList for *;

    TestContract public testContract;
    DummyContract1 public dummy1;
    DummyContract2 public dummy2;
    DummyContract3 public dummy3;

    bytes4 public constant TEST_SELECTOR = bytes4(keccak256("test()"));

    function setUp() public {
        testContract = new TestContract();
        dummy1 = new DummyContract1();
        dummy2 = new DummyContract2();
        dummy3 = new DummyContract3();
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

    function test_SucceedsIfInitializationStatusIsCorrect() public {
        // Should not be initialized at start
        assertFalse(LibAllowList.isMigrated());

        // Initialize with empty arrays
        address[] memory emptyContracts = new address[](0);
        bytes4[] memory emptySelectors = new bytes4[](0);

        LibAllowList.migrate(emptyContracts, emptySelectors);

        // Should be initialized now
        assertTrue(LibAllowList.isMigrated());
    }

    function test_SucceedsIfInitConfigWorksWithEmptyArrays() public {
        address[] memory emptyContracts = new address[](0);
        bytes4[] memory emptySelectors = new bytes4[](0);

        // Initialize with empty arrays
        LibAllowList.migrate(emptyContracts, emptySelectors);

        // Should be initialized but with no contracts or selectors
        assertTrue(LibAllowList.isMigrated());
        assertEq(LibAllowList.getAllowedContracts().length, 0);
        assertEq(LibAllowList.getAllowedSelectors().length, 0);
    }

    function test_SucceedsIfInitConfigResetsPreviousData() public {
        // Step 1: Add some initial data
        LibAllowList.addAllowedContract(address(testContract));
        LibAllowList.addAllowedContract(address(dummy1));
        LibAllowList.addAllowedSelector(TEST_SELECTOR);
        LibAllowList.addAllowedSelector(bytes4(keccak256("oldFunction()")));

        // Verify initial data is there
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)));
        assertTrue(LibAllowList.contractIsAllowed(address(dummy1)));
        assertTrue(LibAllowList.selectorIsAllowed(TEST_SELECTOR));
        assertTrue(
            LibAllowList.selectorIsAllowed(bytes4(keccak256("oldFunction()")))
        );
        assertEq(LibAllowList.getAllowedContracts().length, 2);
        assertEq(LibAllowList.getAllowedSelectors().length, 2);

        // Step 2: Initialize with new data
        address[] memory newContracts = new address[](2);
        newContracts[0] = address(dummy2);
        newContracts[1] = address(dummy3);

        bytes4[] memory newSelectors = new bytes4[](2);
        newSelectors[0] = bytes4(keccak256("newFunction1()"));
        newSelectors[1] = bytes4(keccak256("newFunction2()"));

        LibAllowList.migrate(newContracts, newSelectors);

        // Step 3: Verify old data is cleared and new data is set
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)));
        assertFalse(LibAllowList.contractIsAllowed(address(dummy1)));
        assertTrue(LibAllowList.contractIsAllowed(address(dummy2)));
        assertTrue(LibAllowList.contractIsAllowed(address(dummy3)));

        assertFalse(LibAllowList.selectorIsAllowed(TEST_SELECTOR));
        assertFalse(
            LibAllowList.selectorIsAllowed(bytes4(keccak256("oldFunction()")))
        );
        assertTrue(
            LibAllowList.selectorIsAllowed(bytes4(keccak256("newFunction1()")))
        );
        assertTrue(
            LibAllowList.selectorIsAllowed(bytes4(keccak256("newFunction2()")))
        );

        // Verify array lengths
        assertEq(LibAllowList.getAllowedContracts().length, 2);
        assertEq(LibAllowList.getAllowedSelectors().length, 2);
    }

    function test_SucceedsIfInitConfigPreventsReinitialization() public {
        // Initialize first time
        address[] memory firstContracts = new address[](1);
        firstContracts[0] = address(dummy1);
        bytes4[] memory firstSelectors = new bytes4[](1);
        firstSelectors[0] = bytes4(keccak256("firstFunction()"));

        LibAllowList.migrate(firstContracts, firstSelectors);

        // Verify first initialization
        assertTrue(LibAllowList.isMigrated());
        assertTrue(LibAllowList.contractIsAllowed(address(dummy1)));
        assertTrue(
            LibAllowList.selectorIsAllowed(
                bytes4(keccak256("firstFunction()"))
            )
        );

        // Try to initialize again with different data
        address[] memory secondContracts = new address[](1);
        secondContracts[0] = address(dummy2);
        bytes4[] memory secondSelectors = new bytes4[](1);
        secondSelectors[0] = bytes4(keccak256("secondFunction()"));

        LibAllowList.migrate(secondContracts, secondSelectors);

        // Verify that data didn't change (reinitialization was prevented)
        assertTrue(LibAllowList.contractIsAllowed(address(dummy1)));
        assertFalse(LibAllowList.contractIsAllowed(address(dummy2)));
        assertTrue(
            LibAllowList.selectorIsAllowed(
                bytes4(keccak256("firstFunction()"))
            )
        );
        assertFalse(
            LibAllowList.selectorIsAllowed(
                bytes4(keccak256("secondFunction()"))
            )
        );
    }

    function test_SucceedsIfInitConfigHandlesLargeArrays() public {
        // Create larger arrays to test efficiency
        address[] memory contracts = new address[](3);
        contracts[0] = address(dummy1);
        contracts[1] = address(dummy2);
        contracts[2] = address(dummy3);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = bytes4(keccak256("func1()"));
        selectors[1] = bytes4(keccak256("func2()"));
        selectors[2] = bytes4(keccak256("func3()"));
        selectors[3] = bytes4(keccak256("func4()"));
        selectors[4] = bytes4(keccak256("func5()"));

        LibAllowList.migrate(contracts, selectors);

        // Verify all contracts are allowed
        for (uint256 i = 0; i < contracts.length; i++) {
            assertTrue(LibAllowList.contractIsAllowed(contracts[i]));
        }

        // Verify all selectors are allowed
        for (uint256 i = 0; i < selectors.length; i++) {
            assertTrue(LibAllowList.selectorIsAllowed(selectors[i]));
        }

        // Verify array lengths
        assertEq(LibAllowList.getAllowedContracts().length, 3);
        assertEq(LibAllowList.getAllowedSelectors().length, 5);
    }

    function testRevert_FailsIfAddingZeroAddressContract() public {
        vm.expectRevert(InvalidContract.selector);
        LibAllowList.addAllowedContract(address(0));
    }

    function testRevert_FailsIfAddingNonContract() public {
        vm.expectRevert(InvalidContract.selector);
        LibAllowList.addAllowedContract(address(0x123456));
    }

    function testRevert_FailsIfInitConfigWithInvalidContract() public {
        address[] memory invalidContracts = new address[](2);
        invalidContracts[0] = address(dummy1);
        invalidContracts[1] = address(0); // Invalid contract

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = bytes4(keccak256("func()"));

        vm.expectRevert(InvalidContract.selector);
        LibAllowList.migrate(invalidContracts, selectors);
    }

    function test_SucceedsIfInitConfigWithValidationStillWorks() public {
        // Test that initConfig still validates contracts properly
        address[] memory contracts = new address[](1);
        contracts[0] = address(dummy1);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = bytes4(keccak256("func()"));

        // This should work fine
        LibAllowList.migrate(contracts, selectors);

        assertTrue(LibAllowList.contractIsAllowed(address(dummy1)));
        assertTrue(
            LibAllowList.selectorIsAllowed(bytes4(keccak256("func()")))
        );
    }
}
