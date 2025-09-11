// SPDX-License-Identifier: LGPL-3-0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";
import { InvalidCallData } from "../../../src/Errors/GenericErrors.sol";

contract TestContract {
    // Empty contract for testing
}

contract LibAllowListTest is Test {
    using LibAllowList for *;

    TestContract public testContract;
    bytes4 public constant SELECTOR_A = bytes4(keccak256("functionA()"));
    bytes4 public constant SELECTOR_B = bytes4(keccak256("functionB()"));
    bytes4 public constant SELECTOR_C = bytes4(keccak256("functionC()"));

    // The special selector used to mark a contract as a valid target for approvals.
    // This value must match the `APPROVE_SELECTOR` constant in `LibAllowList.sol`.
    bytes4 internal constant APPROVE_SELECTOR = 0xffffffff;

    /// @dev A helper struct to define the expected state of the allow list for assertions.
    struct StateAssertion {
        address contractAddr;
        bytes4 selector;
        bool pairShouldExist;
        bool contractShouldExistInBC;
        bool selectorShouldExistInBC;
        uint256 globalContractCount;
        uint256 globalSelectorCount;
        uint256 localSelectorCount;
    }

    function setUp() public {
        testContract = new TestContract();
    }

    function test_AddAndRemoveSinglePair() public {
        // --- Add Pair ---
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        _assertStateSyncedAndCorrect(StateAssertion({
            contractAddr: address(testContract),
            selector: SELECTOR_A,
            pairShouldExist: true,
            contractShouldExistInBC: true,
            selectorShouldExistInBC: true,
            globalContractCount: 1,
            globalSelectorCount: 1,
            localSelectorCount: 1
        }));

        // --- Remove Pair ---
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);
        _assertStateSyncedAndCorrect(StateAssertion({
            contractAddr: address(testContract),
            selector: SELECTOR_A,
            pairShouldExist: false,
            contractShouldExistInBC: false,
            selectorShouldExistInBC: false,
            globalContractCount: 0,
            globalSelectorCount: 0,
            localSelectorCount: 0
        }));
    }

    function test_AddAndRemovePairMultipleTimes() public {
        // Add the same pair three times
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);

        // State should be as if it were added once
        _assertStateSyncedAndCorrect(StateAssertion({
            contractAddr: address(testContract),
            selector: SELECTOR_A,
            pairShouldExist: true,
            contractShouldExistInBC: true,
            selectorShouldExistInBC: true,
            globalContractCount: 1,
            globalSelectorCount: 1,
            localSelectorCount: 1
        }));

        // Remove the pair once
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);
        // Remove it again (should be idempotent and do not revert)
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);

        // State should be empty
        _assertStateSyncedAndCorrect(StateAssertion({
            contractAddr: address(testContract),
            selector: SELECTOR_A,
            pairShouldExist: false,
            contractShouldExistInBC: false,
            selectorShouldExistInBC: false,
            globalContractCount: 0,
            globalSelectorCount: 0,
            localSelectorCount: 0
        }));
    }

    function test_RemoveNonExistentPair() public {
        // Try to remove a pair that was never added
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);

        // State should be empty
        _assertStateSyncedAndCorrect(StateAssertion({
            contractAddr: address(testContract),
            selector: SELECTOR_A,
            pairShouldExist: false,
            contractShouldExistInBC: false,
            selectorShouldExistInBC: false,
            globalContractCount: 0,
            globalSelectorCount: 0,
            localSelectorCount: 0
        }));
    }

    /// Reference Counting Tests ///

    function test_ContractReferenceCountingWithMultipleSelectors() public {
        // Add two different selectors to the same contract
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_B);

        // Check state after additions
        // New Granular State
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Selector A should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Selector B should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 2, "New: Contract should have 2 selectors");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should exist");
        assertEq(LibAllowList.getAllowedContracts().length, 1, "BC: Should only be 1 contract in global list");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector A should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector B should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 2, "BC: Should only be 2 selectors in global list");

        // Remove one selector
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);

        // Check state after first removal
        // New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Selector A should be removed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Selector B should remain");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 1, "New: Contract should have 1 selector left");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should STILL exist due to reference count");
        assertEq(LibAllowList.getAllowedContracts().length, 1, "BC: Still 1 contract in global list");
        assertFalse(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector A should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector B should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 1, "BC: Should only be 1 selector in global list");

        // Remove the second selector
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_B);

        // Check state after first second
        // New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Selector A should be removed");
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Selector B should be removed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 0, "New: Contract should have 0 selectors left");
        // Backward Compatibility State
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should NOT be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 0, "BC: There should be 0 contracts in global list");
        assertFalse(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector A should NOT exist");
        assertFalse(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector B should NOT exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 0, "BC: Should only be 0 selectors in global list");

    }

    function test_SelectorReferenceCountingAcrossMultipleContracts() public {
        TestContract contract2 = new TestContract();

        // Add the same selector to two different contracts
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(contract2), SELECTOR_A);

        // Check state after additions
        // New Granular State
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_A), "New: Pair 2 should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 1, "New: Contract should have 1 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 1, "New: Contract should have 1 selectors left");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should be allowed");
        assertTrue(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 2, "BC: There should be 2 contracts in global list");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 1, "BC: Only 1 selector in global list");

        // Remove selector from the first contract
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);

        // Check state after first removal
        // New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should NOT be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_A), "New: Pair 2 should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 0, "New: Contract should have 0 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 1, "New: Contract should have 1 selectors left");
        // Backward Compatibility State
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should NOT be allowed");
        assertTrue(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 1, "BC: There should be 1 contracts in global list");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 1, "BC: Only 1 selector in global list");

        // Remove selector from the second contract
        LibAllowList.removeAllowedContractSelector(address(contract2), SELECTOR_A);
        
        // New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should NOT be allowed");
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_A), "New: Pair 2 should NOT be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 0, "New: Contract should have 0 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 0, "New: Contract should have 0 selectors left");
        // Backward Compatibility State
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should NOT be allowed");
        assertFalse(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should NOT be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 0, "BC: There should be 0 contracts in global list");
        assertFalse(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should NOT exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 0, "BC: Only 0 selectors in global list");
    }

    function test_ApproveTargetSelectorFunctionality() public {
        // Add contract as an approve-only target. APPROVE_SELECTOR is a special selector used to mark a contract as a valid target for approvals. Used for backward compatibility. It is not used for the new granular system.
        LibAllowList.addAllowedContractSelector(address(testContract), APPROVE_SELECTOR);

        // Check New Granular State
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), APPROVE_SELECTOR), "New: Pair 1 should NOT be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 1, "New: Contract should have 1 selectors left");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 1, "BC: There should be 1 contracts in global list");
        assertTrue(LibAllowList.selectorIsAllowed(APPROVE_SELECTOR), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 1, "BC: Only 1 selectors in global list");

        // Remove approve target status
        LibAllowList.removeAllowedContractSelector(address(testContract), APPROVE_SELECTOR);

        // Check New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), APPROVE_SELECTOR), "New: Pair 1 should NOT be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 0, "New: Contract should have 0 selectors left");
        // Backward Compatibility State
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should NOT be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 0, "BC: There should be 0 contracts in global list");
        assertFalse(LibAllowList.selectorIsAllowed(APPROVE_SELECTOR), "BC: Selector should NOT exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 0, "BC: Only 0 selectors in global list");
    }

    // =================================================================
    // ============== COMPLEX SCENARIOS & EDGE CASES ===================
    // =================================================================

    function test_MultipleContractsWithOverlappingSelectors() public {
        TestContract contract2 = new TestContract();

        // Setup
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_B);
        LibAllowList.addAllowedContractSelector(address(contract2), SELECTOR_B);
        LibAllowList.addAllowedContractSelector(address(contract2), SELECTOR_C);

        // Check initial state
        // Check New Granular State
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Pair 2 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_B), "New: Pair 3 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_C), "New: Pair 4 should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 2, "New: Contract should have 2 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 2, "New: Contract should have 2 selectors left");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should be allowed");
        assertTrue(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 2, "BC: There should be 2 contracts in global list");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_C), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 3, "BC: Only 3 selectors in global list");

        // Action: Remove SELECTOR_B from testContract
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_B);

        // Check intermediate state
        // Check New Granular State
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should be allowed");
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Pair 2 should NOT be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_B), "New: Pair 3 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_C), "New: Pair 4 should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 1, "New: Contract should have 1 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 2, "New: Contract should have 2 selectors left");
        // Backward Compatibility State
        assertTrue(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should be allowed");
        assertTrue(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 2, "BC: There should be 2 contracts in global list");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_C), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 3, "BC: Only 3 selectors in global list");

        // Action: Remove SELECTOR_A from testContract
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_A);

        // Check final state for contract1
        // Check New Granular State
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_A), "New: Pair 1 should NOT be allowed");
        assertFalse(LibAllowList.contractSelectorIsAllowed(address(testContract), SELECTOR_B), "New: Pair 2 should NOT be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_B), "New: Pair 3 should be allowed");
        assertTrue(LibAllowList.contractSelectorIsAllowed(address(contract2), SELECTOR_C), "New: Pair 4 should be allowed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(testContract)).length, 0, "New: Contract should have 0 selectors left");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(address(contract2)).length, 2, "New: Contract should have 2 selectors left");
        // Backward Compatibility State
        assertFalse(LibAllowList.contractIsAllowed(address(testContract)), "BC: Contract should NOT be allowed");
        assertTrue(LibAllowList.contractIsAllowed(address(contract2)), "BC: Contract should be allowed");
        assertEq(LibAllowList.getAllowedContracts().length, 1, "BC: There should be 1 contracts in global list");
        assertFalse(LibAllowList.selectorIsAllowed(SELECTOR_A), "BC: Selector should exist");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_B), "BC: Selector should exist from contract2");
        assertTrue(LibAllowList.selectorIsAllowed(SELECTOR_C), "BC: Selector should exist");
        assertEq(LibAllowList.getAllowedSelectors().length, 2, "BC: Only 2 selectors in global list");
    }

    function test_IterableListMaintainsCorrectOrderAfterRemoval() public {
        // Add three selectors
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_A);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_B);
        LibAllowList.addAllowedContractSelector(address(testContract), SELECTOR_C);

        bytes4[] memory selectors = LibAllowList.getWhitelistedSelectorsForContract(address(testContract));
        assertEq(selectors.length, 3);
        assertEq(selectors[0], SELECTOR_A);
        assertEq(selectors[1], SELECTOR_B);
        assertEq(selectors[2], SELECTOR_C);

        // Remove the middle one (B). The last one (C) should take its place.
        LibAllowList.removeAllowedContractSelector(address(testContract), SELECTOR_B);
        
        selectors = LibAllowList.getWhitelistedSelectorsForContract(address(testContract));
        assertEq(selectors.length, 2);
        assertEq(selectors[0], SELECTOR_A, "First element should be unchanged");
        assertEq(selectors[1], SELECTOR_C, "Last element should have replaced the middle one");
    }

    function testRevert_AddZeroAddress() public {
        // Expect a revert when adding the zero address
        vm.expectRevert(InvalidCallData.selector);
        this._addAllowedContractSelectorExternal(address(0), SELECTOR_A);
    }

    // External wrapper function to create proper call depth
    function _addAllowedContractSelectorExternal(address _contract, bytes4 _selector) external {
        LibAllowList.addAllowedContractSelector(_contract, _selector);
    }

    /// @dev A single helper to check all states for simple cases.
    function _assertStateSyncedAndCorrect(StateAssertion memory _params) internal {
        // Check New Granular State
        assertEq(LibAllowList.contractSelectorIsAllowed(_params.contractAddr, _params.selector), _params.pairShouldExist, "New: Granular pair check failed");
        assertEq(LibAllowList.getWhitelistedSelectorsForContract(_params.contractAddr).length, _params.localSelectorCount, "New: Local selector count mismatch");

        // Check Backward Compatibility State
        assertEq(LibAllowList.contractIsAllowed(_params.contractAddr), _params.contractShouldExistInBC, "BC: Global contract check failed");
        assertEq(LibAllowList.selectorIsAllowed(_params.selector), _params.selectorShouldExistInBC, "BC: Global selector check failed");
        assertEq(LibAllowList.getAllowedContracts().length, _params.globalContractCount, "BC: Global contract count mismatch");
        assertEq(LibAllowList.getAllowedSelectors().length, _params.globalSelectorCount, "BC: Global selector count mismatch");
    }
}

