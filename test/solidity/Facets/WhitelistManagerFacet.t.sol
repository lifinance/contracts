// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { InvalidContract, InvalidCallData, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { DeployScript } from "../../../script/deploy/facets/UpdateWhitelistManagerFacet.s.sol";

contract Foo {}

/// @title Mock Swapper Facet
/// @notice Mock facet that simulates SwapperV2 allow list logic for testing
contract MockSwapperFacet {
    function isContractSelectorAllowed(
        address _contract,
        bytes4 _selector
    ) external view returns (bool) {
        return LibAllowList.contractSelectorIsAllowed(_contract, _selector);
    }

    /// @notice [Backward Compatibility] Checks if a contract is on the global V1 allow list.
    function isContractAllowedLegacy(
        address _contract
    ) external view returns (bool) {
        return LibAllowList.contractIsAllowed(_contract);
    }

    /// @notice [Backward Compatibility] Checks if a selector is on the global V1 allow list.
    function isSelectorAllowedLegacy(
        bytes4 _selector
    ) external view returns (bool) {
        return LibAllowList.selectorIsAllowed(_selector);
    }
}

contract WhitelistManagerFacetTest is DSTest, DiamondTest {
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER = address(0x123456);
    address internal constant NOT_DIAMOND_OWNER = address(0xabc123456);

    LiFiDiamond internal diamond;
    WhitelistManagerFacet internal whitelistMgr;
    AccessManagerFacet internal accessMgr;
    Foo internal c1;
    Foo internal c2;
    Foo internal c3;
    Foo internal c4;
    Foo internal c5;

    event ContractSelectorWhitelistChanged(
        address indexed contractAddress,
        bytes4 indexed functionSelector,
        bool indexed approved
    );

    function setUp() public {
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        whitelistMgr = new WhitelistManagerFacet();
        c1 = new Foo();
        c2 = new Foo();
        c3 = new Foo();
        c4 = new Foo();
        c5 = new Foo();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = WhitelistManagerFacet
            .setContractSelectorWhitelist
            .selector;
        functionSelectors[1] = WhitelistManagerFacet
            .batchSetContractSelectorWhitelist
            .selector;
        functionSelectors[2] = WhitelistManagerFacet
            .isContractSelectorWhitelisted
            .selector;
        functionSelectors[3] = WhitelistManagerFacet
            .getWhitelistedSelectorsForContract
            .selector;
        functionSelectors[4] = WhitelistManagerFacet
            .getAllContractSelectorPairs
            .selector;

        addFacet(diamond, address(whitelistMgr), functionSelectors);

        // add AccessManagerFacet to be able to whitelist addresses for execution of protected functions
        accessMgr = new AccessManagerFacet();

        functionSelectors = new bytes4[](2);
        functionSelectors[0] = accessMgr.setCanExecute.selector;
        functionSelectors[1] = accessMgr.addressCanExecuteMethod.selector;
        addFacet(diamond, address(accessMgr), functionSelectors);

        accessMgr = AccessManagerFacet(address(diamond));
        whitelistMgr = WhitelistManagerFacet(address(diamond));
    }

    function test_SucceedsIfOwnerAddsAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true);
        emit ContractSelectorWhitelistChanged(address(c1), 0xDEADDEAD, true);

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            true
        );
        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedSelectorsForContract(address(c1));
        assertEq(selectors.length, 1);
        assertTrue(selectors[0] == 0xDEADDEAD);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerRemovesAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            true
        );

        vm.expectEmit(true, true, true, true);
        emit ContractSelectorWhitelistChanged(address(c1), 0xDEADDEAD, false);

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            false
        );

        vm.stopPrank();

        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedSelectorsForContract(address(c1));
        assertEq(selectors.length, 0);
    }

    function _batchSetContractSelectorWhitelist(
        address[] memory addresses
    ) internal {
        // Create selectors array with same length as addresses
        bytes4[] memory selectors = new bytes4[](addresses.length);
        for (uint256 i = 0; i < addresses.length; i++) {
            selectors[i] = 0xDEADDEAD;
            vm.expectEmit(true, true, true, true);
            emit ContractSelectorWhitelistChanged(
                addresses[i],
                0xDEADDEAD,
                true
            );
        }
        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        // Check each contract has the selector whitelisted
        for (uint256 i = 0; i < addresses.length; i++) {
            bytes4[] memory contractSelectors = whitelistMgr
                .getWhitelistedSelectorsForContract(addresses[i]);
            assertEq(contractSelectors.length, 1);
            assertTrue(contractSelectors[0] == 0xDEADDEAD);
        }
    }

    function test_SucceedsIfOwnerBatchAddsAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);

        _batchSetContractSelectorWhitelist(addresses);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchRemovesAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);

        _batchSetContractSelectorWhitelist(addresses);

        address[] memory remove = new address[](2);
        remove[0] = address(c1);
        remove[1] = address(c2);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        whitelistMgr.batchSetContractSelectorWhitelist(
            remove,
            selectors,
            false
        );

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerApprovesFunctionSelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";

        vm.expectEmit(true, true, true, true);
        emit ContractSelectorWhitelistChanged(address(c1), selector, true);

        whitelistMgr.setContractSelectorWhitelist(address(c1), selector, true);
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector)
        );

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchApprovesFunctionSelectors() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"deaddead");
        selectors[3] = bytes4(hex"deadface");
        selectors[4] = bytes4(hex"beefbeef");

        address[] memory contracts = new address[](5);
        contracts[0] = address(c1);
        contracts[1] = address(c1);
        contracts[2] = address(c1);
        contracts[3] = address(c1);
        contracts[4] = address(c1);

        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            selectors,
            true
        );
        for (uint256 i = 0; i < 5; ) {
            assertTrue(
                whitelistMgr.isContractSelectorWhitelisted(
                    address(c1),
                    selectors[i]
                )
            );
            unchecked {
                ++i;
            }
        }

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidCallData.selector);

        whitelistMgr.setContractSelectorWhitelist(
            address(0),
            0xDEADDEAD,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingAddressThatIsNotAContract() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.setContractSelectorWhitelist(
            address(1337),
            0xDEADDEAD,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchAddingWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(0);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;
        selectors[2] = 0xDEADDEAD;

        vm.expectRevert(InvalidCallData.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchAddingAddressesThatAreNotContracts()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(1337);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;
        selectors[2] = 0xDEADDEAD;

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToAddAddress() public {
        vm.startPrank(NOT_DIAMOND_OWNER); // prank a non-owner to attempt adding an address

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToBatchAddAddresses() public {
        vm.startPrank(NOT_DIAMOND_OWNER);
        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(c2);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingAddressThatIsWhitelistManager() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(whitelistMgr); // contract itself

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        vm.expectRevert(CannotAuthoriseSelf.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToRemoveAddress() public {
        vm.prank(USER_DIAMOND_OWNER);

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            true
        );

        vm.stopPrank();

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xDEADDEAD,
            false
        );
    }

    function testRevert_FailsIfNonOwnerTriesToBatchRemoveAddresses() public {
        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(c2);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        vm.prank(USER_DIAMOND_OWNER);
        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            false
        );
    }

    function testRevert_FailsIfNonOwnerTriesTosetFunctionWhitelistBySelector()
        public
    {
        bytes4 selector = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.setContractSelectorWhitelist(address(c1), selector, true);
    }

    function testRevert_FailsIfNotOwnerBatchSetsFunctionApprovalBySelector()
        public
    {
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        address[] memory contracts = new address[](3);
        contracts[0] = address(c1);
        contracts[1] = address(c1);
        contracts[2] = address(c1);

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            selectors,
            true
        );
    }

    function test_SucceedsIfOwnerSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";

        whitelistMgr.setContractSelectorWhitelist(address(c1), selector, true);
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector)
        );

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            selector,
            false
        );
        assertFalse(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector)
        );

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        address[] memory contracts = new address[](3);
        contracts[0] = address(c1);
        contracts[1] = address(c1);
        contracts[2] = address(c1);

        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            selectors,
            true
        );
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(
                whitelistMgr.isContractSelectorWhitelisted(
                    address(c1),
                    selectors[i]
                )
            );
        }

        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            selectors,
            false
        );
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(
                whitelistMgr.isContractSelectorWhitelisted(
                    address(c1),
                    selectors[i]
                )
            );
        }

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsReturnsCorrectData()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Set up test data: 3 contracts with different selector configurations
        address[] memory testContracts = new address[](3);
        testContracts[0] = address(c1);
        testContracts[1] = address(c2);
        testContracts[2] = address(c3);

        bytes4[] memory testSelectors = new bytes4[](3);
        testSelectors[0] = 0xDEADDEAD;
        testSelectors[1] = 0xBEEFBEEF;
        testSelectors[2] = 0xFACEFACE;

        // Add contract-selector pairs
        whitelistMgr.batchSetContractSelectorWhitelist(
            testContracts,
            testSelectors,
            true
        );

        // Add additional selectors for c1
        address[] memory c1Contracts = new address[](2);
        c1Contracts[0] = address(c1);
        c1Contracts[1] = address(c1);

        bytes4[] memory c1AdditionalSelectors = new bytes4[](2);
        c1AdditionalSelectors[0] = 0x12345678;
        c1AdditionalSelectors[1] = 0x87654321;

        whitelistMgr.batchSetContractSelectorWhitelist(
            c1Contracts,
            c1AdditionalSelectors,
            true
        );

        // Call getAllContractSelectorPairs
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = whitelistMgr.getAllContractSelectorPairs();

        // Verify contracts array
        assertEq(contracts.length, 3, "Should return 3 contracts");
        assertEq(contracts[0], address(c1), "First contract should be c1");
        assertEq(contracts[1], address(c2), "Second contract should be c2");
        assertEq(contracts[2], address(c3), "Third contract should be c3");

        // Verify selectors array has same length as contracts
        assertEq(
            selectors.length,
            3,
            "Selectors array should have same length as contracts"
        );

        // Verify c1 has 3 selectors (0xDEADDEAD, 0x12345678, 0x87654321)
        assertEq(selectors[0].length, 3, "c1 should have 3 selectors");
        bool foundDeadDead = false;
        bool found12345678 = false;
        bool found87654321 = false;
        for (uint256 i = 0; i < selectors[0].length; i++) {
            if (selectors[0][i] == 0xDEADDEAD) foundDeadDead = true;
            if (selectors[0][i] == 0x12345678) found12345678 = true;
            if (selectors[0][i] == 0x87654321) found87654321 = true;
        }
        assertTrue(foundDeadDead, "c1 should have 0xDEADDEAD selector");
        assertTrue(found12345678, "c1 should have 0x12345678 selector");
        assertTrue(found87654321, "c1 should have 0x87654321 selector");

        // Verify c2 has 1 selector (0xBEEFBEEF)
        assertEq(selectors[1].length, 1, "c2 should have 1 selector");
        assertTrue(
            selectors[1][0] == 0xBEEFBEEF,
            "c2 should have 0xBEEFBEEF selector"
        );

        // Verify c3 has 1 selector (0xFACEFACE)
        assertEq(selectors[2].length, 1, "c3 should have 1 selector");
        assertTrue(
            selectors[2][0] == 0xFACEFACE,
            "c3 should have 0xFACEFACE selector"
        );

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsReturnsEmptyArraysWhenNoWhitelist()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Call getAllContractSelectorPairs with no whitelisted contracts
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = whitelistMgr.getAllContractSelectorPairs();

        // Verify empty arrays
        assertEq(contracts.length, 0, "Should return empty contracts array");
        assertEq(selectors.length, 0, "Should return empty selectors array");

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsHandlesContractWithNoSelectors()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Add a contract with ApproveTo-Only Selector (0xffffffff)
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xffffffff,
            true
        );

        // Call getAllContractSelectorPairs
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = whitelistMgr.getAllContractSelectorPairs();

        // Verify single contract
        assertEq(contracts.length, 1, "Should return 1 contract");
        assertEq(contracts[0], address(c1), "Should return c1");

        // Verify selectors array
        assertEq(selectors.length, 1, "Should return 1 selector array");
        assertEq(selectors[0].length, 1, "c1 should have 1 selector");
        assertTrue(
            selectors[0][0] == 0xffffffff,
            "c1 should have ApproveTo-Only Selector"
        );

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsHandlesMixedContractTypes()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Contract 1: Multiple real selectors
        address[] memory c1Contracts = new address[](2);
        c1Contracts[0] = address(c1);
        c1Contracts[1] = address(c1);

        bytes4[] memory c1Selectors = new bytes4[](2);
        c1Selectors[0] = 0xDEADDEAD;
        c1Selectors[1] = 0xBEEFBEEF;

        whitelistMgr.batchSetContractSelectorWhitelist(
            c1Contracts,
            c1Selectors,
            true
        );

        // Contract 2: ApproveTo-Only Selector only (no function calls allowed)
        whitelistMgr.setContractSelectorWhitelist(
            address(c2),
            0xffffffff,
            true
        );

        // Contract 3: Single real selector
        whitelistMgr.setContractSelectorWhitelist(
            address(c3),
            0xFACEFACE,
            true
        );

        // Call getAllContractSelectorPairs
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = whitelistMgr.getAllContractSelectorPairs();

        // Verify 3 contracts
        assertEq(contracts.length, 3, "Should return 3 contracts");

        // Find each contract in the result
        uint256 c1Index = 0;
        uint256 c2Index = 0;
        uint256 c3Index = 0;
        bool foundC1 = false;
        bool foundC2 = false;
        bool foundC3 = false;

        for (uint256 i = 0; i < contracts.length; i++) {
            if (contracts[i] == address(c1)) {
                c1Index = i;
                foundC1 = true;
            } else if (contracts[i] == address(c2)) {
                c2Index = i;
                foundC2 = true;
            } else if (contracts[i] == address(c3)) {
                c3Index = i;
                foundC3 = true;
            }
        }

        assertTrue(foundC1, "Should find c1");
        assertTrue(foundC2, "Should find c2");
        assertTrue(foundC3, "Should find c3");

        // Verify c1 has 2 selectors
        assertEq(selectors[c1Index].length, 2, "c1 should have 2 selectors");
        bool foundDeadDead = false;
        bool foundBeefBeef = false;
        for (uint256 i = 0; i < selectors[c1Index].length; i++) {
            if (selectors[c1Index][i] == 0xDEADDEAD) foundDeadDead = true;
            if (selectors[c1Index][i] == 0xBEEFBEEF) foundBeefBeef = true;
        }
        assertTrue(foundDeadDead, "c1 should have 0xDEADDEAD selector");
        assertTrue(foundBeefBeef, "c1 should have 0xBEEFBEEF selector");

        // Verify c2 has ApproveTo-Only Selector
        assertEq(selectors[c2Index].length, 1, "c2 should have 1 selector");
        assertTrue(
            selectors[c2Index][0] == 0xffffffff,
            "c2 should have ApproveTo-Only Selector"
        );

        // Verify c3 has single selector
        assertEq(selectors[c3Index].length, 1, "c3 should have 1 selector");
        assertTrue(
            selectors[c3Index][0] == 0xFACEFACE,
            "c3 should have 0xFACEFACE selector"
        );

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsIsEfficient() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Add multiple contracts with multiple selectors to test efficiency
        address[] memory contracts = new address[](5);
        contracts[0] = address(c1);
        contracts[1] = address(c2);
        contracts[2] = address(c3);
        contracts[3] = address(c4);
        contracts[4] = address(c5);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xBEEFBEEF;
        selectors[2] = 0xFACEFACE;
        selectors[3] = 0x12345678;
        selectors[4] = 0x87654321;

        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            selectors,
            true
        );

        // Add additional selectors for some contracts
        address[] memory additionalContracts = new address[](3);
        additionalContracts[0] = address(c1);
        additionalContracts[1] = address(c1);
        additionalContracts[2] = address(c2);

        bytes4[] memory additionalSelectors = new bytes4[](3);
        additionalSelectors[0] = 0x11111111;
        additionalSelectors[1] = 0x22222222;
        additionalSelectors[2] = 0x33333333;

        whitelistMgr.batchSetContractSelectorWhitelist(
            additionalContracts,
            additionalSelectors,
            true
        );

        // Call getAllContractSelectorPairs
        (
            address[] memory returnedContracts,
            bytes4[][] memory returnedSelectors
        ) = whitelistMgr.getAllContractSelectorPairs();

        // Verify all contracts are returned
        assertEq(returnedContracts.length, 5, "Should return all 5 contracts");
        assertEq(
            returnedSelectors.length,
            5,
            "Should return 5 selector arrays"
        );

        // Verify c1 has 3 selectors (0xDEADDEAD, 0x11111111, 0x22222222)
        uint256 c1Index = 0;
        for (uint256 i = 0; i < returnedContracts.length; i++) {
            if (returnedContracts[i] == address(c1)) {
                c1Index = i;
                break;
            }
        }
        assertEq(
            returnedSelectors[c1Index].length,
            3,
            "c1 should have 3 selectors"
        );

        // Verify c2 has 2 selectors (0xBEEFBEEF, 0x33333333)
        uint256 c2Index = 0;
        for (uint256 i = 0; i < returnedContracts.length; i++) {
            if (returnedContracts[i] == address(c2)) {
                c2Index = i;
                break;
            }
        }
        assertEq(
            returnedSelectors[c2Index].length,
            2,
            "c2 should have 2 selectors"
        );

        vm.stopPrank();
    }

    function test_SucceedsIfGetWhitelistedSelectorsForContractReturnsCorrectSelectors()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSelectors = new bytes4[](3);
        testSelectors[0] = bytes4(hex"faceface");
        testSelectors[1] = bytes4(hex"deadbeef");
        testSelectors[2] = bytes4(hex"beefbeef");

        address[] memory contracts = new address[](3);
        contracts[0] = address(c1);
        contracts[1] = address(c1);
        contracts[2] = address(c1);

        whitelistMgr.batchSetContractSelectorWhitelist(
            contracts,
            testSelectors,
            true
        );

        // Get selectors for specific contract
        bytes4[] memory returnedSelectors = whitelistMgr
            .getWhitelistedSelectorsForContract(address(c1));

        assertEq(returnedSelectors.length, 3);

        // Verify all selectors are returned (order may vary)
        bool foundSelector0 = false;
        bool foundSelector1 = false;
        bool foundSelector2 = false;

        for (uint256 i = 0; i < returnedSelectors.length; i++) {
            if (returnedSelectors[i] == testSelectors[0])
                foundSelector0 = true;
            if (returnedSelectors[i] == testSelectors[1])
                foundSelector1 = true;
            if (returnedSelectors[i] == testSelectors[2])
                foundSelector2 = true;
        }

        assertTrue(foundSelector0, "Selector 0 should be in returned array");
        assertTrue(foundSelector1, "Selector 1 should be in returned array");
        assertTrue(foundSelector2, "Selector 2 should be in returned array");

        vm.stopPrank();
    }

    function test_SucceedsIfGetAllContractSelectorPairsAndRedundantOperations()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Test getAllContractSelectorPairs with empty state
        (
            address[] memory emptyContracts,
            bytes4[][] memory emptySelectors
        ) = whitelistMgr.getAllContractSelectorPairs();
        assertEq(
            emptyContracts.length,
            0,
            "Should return empty contracts array initially"
        );
        assertEq(
            emptySelectors.length,
            0,
            "Should return empty selectors array initially"
        );

        // Add some contract-selector pairs
        bytes4 selector1 = bytes4(hex"faceface");
        bytes4 selector2 = bytes4(hex"deadbeef");

        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            selector1,
            true
        );
        whitelistMgr.setContractSelectorWhitelist(
            address(c2),
            selector2,
            true
        );

        // Test getAllContractSelectorPairs returns all contract-selector pairs
        (
            address[] memory allContracts,
            bytes4[][] memory allSelectors
        ) = whitelistMgr.getAllContractSelectorPairs();
        assertEq(allContracts.length, 2, "Should return 2 contracts");

        // Verify both contracts and their selectors are present
        bool foundC1 = false;
        bool foundC2 = false;
        for (uint256 i = 0; i < allContracts.length; i++) {
            if (allContracts[i] == address(c1)) {
                foundC1 = true;
                assertEq(
                    allSelectors[i].length,
                    1,
                    "c1 should have 1 selector"
                );
                assertTrue(
                    allSelectors[i][0] == selector1,
                    "c1 should have selector1"
                );
            } else if (allContracts[i] == address(c2)) {
                foundC2 = true;
                assertEq(
                    allSelectors[i].length,
                    1,
                    "c2 should have 1 selector"
                );
                assertTrue(
                    allSelectors[i][0] == selector2,
                    "c2 should have selector2"
                );
            }
        }
        assertTrue(foundC1, "c1 should be in contracts list");
        assertTrue(foundC2, "c2 should be in contracts list");

        // Test redundant operation - try to whitelist the same contract-selector pair again
        // This should trigger the early return in _setContractSelectorWhitelist
        // We verify this by checking that the state doesn't change

        // Verify current state
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector1),
            "Should be whitelisted before redundant call"
        );

        // Make redundant call - this should hit the early return
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            selector1,
            true
        );

        // Verify state is unchanged (proving early return worked)
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector1),
            "Should still be whitelisted after redundant call"
        );

        // Verify contract-selector pairs are unchanged
        (
            address[] memory contractsAfter,
            bytes4[][] memory selectorsAfter
        ) = whitelistMgr.getAllContractSelectorPairs();
        assertEq(
            contractsAfter.length,
            2,
            "Contract count should be unchanged"
        );
        assertEq(
            selectorsAfter.length,
            2,
            "Selector arrays count should be unchanged"
        );

        // Test redundant removal operation
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            selector1,
            false
        );
        assertFalse(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector1),
            "Should be removed"
        );

        // Try to remove again (redundant operation)
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            selector1,
            false
        );
        assertFalse(
            whitelistMgr.isContractSelectorWhitelisted(address(c1), selector1),
            "Should still be removed after redundant call"
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchSetWithMismatchedArrays() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);

        bytes4[] memory selectors = new bytes4[](2); // Mismatched length
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        vm.expectRevert(abi.encodeWithSignature("InvalidConfig()"));

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfTryingToWhitelistDiamondItself() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Try to whitelist the diamond itself (whitelistMgr is the diamond proxy)
        vm.expectRevert(CannotAuthoriseSelf.selector);

        whitelistMgr.setContractSelectorWhitelist(
            address(whitelistMgr),
            0xDEADDEAD,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchWhitelistingDiamondItself() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(whitelistMgr); // The diamond itself

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0xDEADDEAD;
        selectors[1] = 0xDEADDEAD;

        vm.expectRevert(CannotAuthoriseSelf.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerWithoutAccessTriesToBatchSet() public {
        // Test the LibAccess.enforceAccessControl() path
        // This address has no access control permissions
        address unauthorizedUser = address(0xBADBEEF);

        vm.startPrank(unauthorizedUser);

        address[] memory addresses = new address[](1);
        addresses[0] = address(c1);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = 0xDEADDEAD;

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        vm.stopPrank();
    }

    function test_SucceedsIfNonOwnerWithAccessCanBatchSet() public {
        // Test that line 138 (LibAccess.enforceAccessControl()) is executed
        // and allows authorized non-owner to call the function
        address authorizedUser = address(
            0xA17401230000000000000000000000000000000d
        );

        // First, owner grants access to the authorized user
        vm.startPrank(USER_DIAMOND_OWNER);

        // Grant access to batchSetContractSelectorWhitelist function
        bytes4 selector = whitelistMgr
            .batchSetContractSelectorWhitelist
            .selector;
        accessMgr.setCanExecute(selector, authorizedUser, true);

        vm.stopPrank();

        // Now authorized user (not owner) should be able to call the function
        vm.startPrank(authorizedUser);

        address[] memory addresses = new address[](1);
        addresses[0] = address(c1);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = 0xDEADDEAD;

        // This should succeed because authorizedUser has access
        whitelistMgr.batchSetContractSelectorWhitelist(
            addresses,
            selectors,
            true
        );

        // Verify it worked
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(
                address(c1),
                0xDEADDEAD
            ),
            "Contract-selector should be whitelisted"
        );

        vm.stopPrank();
    }

    function test_SucceedsIfNonOwnerWithAccessCanSetSingle() public {
        // Test line 138 for single setter too
        address authorizedUser = address(
            0xA17401230000000000000000000000000000000d
        );

        // First, owner grants access to the authorized user
        vm.startPrank(USER_DIAMOND_OWNER);

        // Grant access to setContractSelectorWhitelist function
        bytes4 selector = whitelistMgr.setContractSelectorWhitelist.selector;
        accessMgr.setCanExecute(selector, authorizedUser, true);

        vm.stopPrank();

        // Now authorized user (not owner) should be able to call the function
        vm.startPrank(authorizedUser);

        // This should succeed because authorizedUser has access
        whitelistMgr.setContractSelectorWhitelist(
            address(c1),
            0xBEEFBEEF,
            true
        );

        // Verify it worked
        assertTrue(
            whitelistMgr.isContractSelectorWhitelisted(
                address(c1),
                0xBEEFBEEF
            ),
            "Contract-selector should be whitelisted"
        );

        vm.stopPrank();
    }
}

contract ExposedUpdateWhitelistManagerFacetDeployScript is DeployScript {
    function exposed_getCallData() public returns (bytes memory) {
        return getCallData();
    }
}
