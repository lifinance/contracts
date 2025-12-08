// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { OwnershipFacet } from "src/Facets/OwnershipFacet.sol";
import { InvalidContract, InvalidCallData, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { TestBase } from "../utils/TestBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
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

        bytes4[] memory functionSelectors = new bytes4[](9);
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
            .getWhitelistedAddresses
            .selector;
        functionSelectors[4] = WhitelistManagerFacet
            .isFunctionSelectorWhitelisted
            .selector;
        functionSelectors[5] = WhitelistManagerFacet
            .isAddressWhitelisted
            .selector;
        functionSelectors[6] = WhitelistManagerFacet
            .getWhitelistedFunctionSelectors
            .selector;
        functionSelectors[7] = WhitelistManagerFacet
            .getWhitelistedSelectorsForContract
            .selector;
        functionSelectors[8] = WhitelistManagerFacet
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
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved[0], address(c1));

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

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 0);
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

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, addresses.length);
        for (uint256 i = 0; i < addresses.length; i++) {
            assertEq(approved[i], addresses[i]);
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
        assertTrue(whitelistMgr.isFunctionSelectorWhitelisted(selector));

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

    function test_SucceedsIfGetWhitelistedFunctionSelectorsAndRedundantOperations()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Test getWhitelistedFunctionSelectors with empty state
        bytes4[] memory emptySelectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
        assertEq(
            emptySelectors.length,
            0,
            "Should return empty array initially"
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

        // Test getWhitelistedFunctionSelectors returns all unique selectors
        bytes4[] memory allSelectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
        assertEq(allSelectors.length, 2, "Should return 2 unique selectors");

        // Verify both selectors are present
        bool foundSelector1 = false;
        bool foundSelector2 = false;
        for (uint256 i = 0; i < allSelectors.length; i++) {
            if (allSelectors[i] == selector1) foundSelector1 = true;
            if (allSelectors[i] == selector2) foundSelector2 = true;
        }
        assertTrue(foundSelector1, "Selector1 should be in global list");
        assertTrue(foundSelector2, "Selector2 should be in global list");

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

        // Verify global selector list is unchanged
        bytes4[] memory selectorsAfter = whitelistMgr
            .getWhitelistedFunctionSelectors();
        assertEq(
            selectorsAfter.length,
            2,
            "Global selector count should be unchanged"
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

/// @notice Test for migrating the allow list configuration during diamond upgrades.
/// @dev This test suite validates the migration from DexManagerFacet to WhitelistManagerFacet.
/// The migration was necessary because:
/// 1. DexManagerFacet was too specific (only for DEXes) while we whitelist various protocols
/// 2. Old storage layout in LibAllowList needed updating
/// 3. Function naming was inconsistent ("approved" vs "whitelist")
/// 4. Whitelisted function selectors were scattered offchain, now stored onchain
///
/// Migration Process:
/// 1. Deploy new WhitelistManagerFacet with migration logic
/// 2. Get current state from old DexManagerFacet (approved addresses and selectors)
/// 3. Migrate to new storage layout while maintaining all permissions
/// 4. Verify that existing integrations (like SwapperV2) continue working
///
/// @dev Remove this test suite after the next facet upgrade when migration is complete
contract WhitelistManagerFacetMigrationTest is TestBase {
    using stdJson for string;

    // Reuse parsing utilities from the deploy script via the exposed wrapper

    // LiFi Diamond on staging base that uses old DexManager and AllowList storage layout
    address internal constant DIAMOND =
        0x947330863B5BA5E134fE8b73e0E1c7Eed90446C7;

    WhitelistManagerFacet internal whitelistManagerWithMigrationLogic;
    MockSwapperFacet internal mockSwapperFacet;
    ExposedUpdateWhitelistManagerFacetDeployScript internal deployScript;
    address[] internal oldContractsBeforeMigration;

    function setUp() public {
        // fork mainnet to test with real production state
        string memory rpcUrl = vm.envString("ETH_NODE_URI_BASE");
        vm.createSelectFork(rpcUrl, 33206380);

        // Set required environment variables for deployment script
        vm.setEnv("NETWORK", "base");
        vm.setEnv("FILE_SUFFIX", "");
        vm.setEnv("USE_DEF_DIAMOND", "true");
        // Use a dummy private key for testing (32 bytes) - needed for github action
        vm.setEnv(
            "PRIVATE_KEY",
            "0x1234567890123456789012345678901234567890123456789012345678901234"
        );

        // Create instance of deployment script to access getCallData
        deployScript = new ExposedUpdateWhitelistManagerFacetDeployScript();
    }

    /// @notice Test that non-owner cannot call migrate function
    function testRevert_FailsIfNonOwnerTriesToCallMigrate() public {
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Add the migrate function to the diamond (but don't execute it yet)
        bytes4[] memory migrateFunctionSelector = new bytes4[](1);
        migrateFunctionSelector[0] = WhitelistManagerFacet.migrate.selector;

        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(whitelistManagerWithMigrationLogic),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: migrateFunctionSelector
        });

        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);
        DiamondCutFacet(DIAMOND).diamondCut(cuts, address(0), "");

        // Now try to call migrate as a non-owner
        address unauthorizedUser = address(0xBADBEEF);

        bytes4[] memory selectorsToRemove = new bytes4[](0);
        address[] memory contracts = new address[](0);
        bytes4[][] memory selectors = new bytes4[][](0);

        vm.prank(unauthorizedUser);
        vm.expectRevert(UnAuthorized.selector);

        WhitelistManagerFacet(DIAMOND).migrate(
            selectorsToRemove,
            contracts,
            selectors
        );
    }

    /// @notice Test that migrate reverts with InvalidConfig when arrays have different lengths
    function testRevert_FailsIfMigrateCalledWithMismatchedArrays() public {
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Add the migrate function to the diamond (but don't execute it yet)
        bytes4[] memory migrateFunctionSelector = new bytes4[](1);
        migrateFunctionSelector[0] = WhitelistManagerFacet.migrate.selector;

        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(whitelistManagerWithMigrationLogic),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: migrateFunctionSelector
        });

        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);
        DiamondCutFacet(DIAMOND).diamondCut(cuts, address(0), "");

        // Create mismatched arrays: 2 contracts but 1 selector array
        bytes4[] memory selectorsToRemove = new bytes4[](0);
        address[] memory contracts = new address[](2);
        contracts[0] = address(0x1234);
        contracts[1] = address(0x5678);

        bytes4[][] memory selectors = new bytes4[][](1); // Only 1 selector array instead of 2
        selectors[0] = new bytes4[](1);
        selectors[0][0] = bytes4(0xdeadbeef);

        // Should revert with InvalidConfig because array lengths don't match
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("InvalidConfig()"));

        WhitelistManagerFacet(DIAMOND).migrate(
            selectorsToRemove,
            contracts,
            selectors
        );
    }

    /// @notice Test that migrate reverts with CannotAuthoriseSelf when trying to whitelist the diamond itself
    function testRevert_FailsIfMigrateTriesToWhitelistDiamond() public {
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Add the migrate function to the diamond (but don't execute it yet)
        bytes4[] memory migrateFunctionSelector = new bytes4[](1);
        migrateFunctionSelector[0] = WhitelistManagerFacet.migrate.selector;

        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(whitelistManagerWithMigrationLogic),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: migrateFunctionSelector
        });

        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);
        DiamondCutFacet(DIAMOND).diamondCut(cuts, address(0), "");

        // Try to whitelist the diamond itself
        bytes4[] memory selectorsToRemove = new bytes4[](0);
        address[] memory contracts = new address[](1);
        contracts[0] = DIAMOND; // Trying to whitelist the diamond itself

        bytes4[][] memory selectors = new bytes4[][](1);
        selectors[0] = new bytes4[](1);
        selectors[0][0] = bytes4(0xdeadbeef);

        // Should revert with CannotAuthoriseSelf
        vm.prank(owner);
        vm.expectRevert(CannotAuthoriseSelf.selector);

        WhitelistManagerFacet(DIAMOND).migrate(
            selectorsToRemove,
            contracts,
            selectors
        );
    }

    /// @notice Test that migrate reverts with InvalidConfig when trying to add duplicate contract-selector pairs
    function testRevert_FailsIfMigrateTriesToAddDuplicateContractSelector()
        public
    {
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Add the migrate function to the diamond (but don't execute it yet)
        bytes4[] memory migrateFunctionSelector = new bytes4[](1);
        migrateFunctionSelector[0] = WhitelistManagerFacet.migrate.selector;

        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(whitelistManagerWithMigrationLogic),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: migrateFunctionSelector
        });

        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);
        DiamondCutFacet(DIAMOND).diamondCut(cuts, address(0), "");

        // Use actual deployed contracts to avoid InvalidContract error
        // We'll use the whitelistManagerWithMigrationLogic contract we just deployed
        address testContract = address(whitelistManagerWithMigrationLogic);

        // Create arrays with duplicate contract-selector pair
        // Same contract appears twice with the same selector
        bytes4[] memory selectorsToRemove = new bytes4[](0);
        address[] memory contracts = new address[](2);
        contracts[0] = testContract;
        contracts[1] = testContract; // Duplicate contract

        bytes4[][] memory selectors = new bytes4[][](2);
        selectors[0] = new bytes4[](1);
        selectors[0][0] = bytes4(0xdeadbeef);
        selectors[1] = new bytes4[](1);
        selectors[1][0] = bytes4(0xdeadbeef); // Same selector for the same contract

        // Should revert with InvalidConfig because of duplicate contract-selector pair
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("InvalidConfig()"));

        WhitelistManagerFacet(DIAMOND).migrate(
            selectorsToRemove,
            contracts,
            selectors
        );
    }

    /// @notice Test that simulates the diamond cut with initialization calldata from the actual deployment script
    /// @dev This test:
    /// 1. Sets up a mock swapper to verify existing integrations
    /// 2. Gets current state from legacy DexManagerFacet using approvedDexs()
    /// 3. Verifies pre-migration state with mock swapper
    /// 4. Loads config data from the same files used in production (prepared staging environment for it)
    /// 5. Gets initialization calldata directly from UpdateWhitelistManagerFacet.s.sol script
    /// 6. Executes diamond cut with that calldata
    /// 7. Verifies post-migration state matches expected values
    function test_DiamondCutWithInitCallDataThatCallsMigrate() public {
        vm.pauseGasMetering();
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Set up mock swapper to verify existing integrations
        _setupMockSwapperFacet();

        // Get current state from legacy DexManagerFacet (call in order to check )
        _getLegacyState();

        // Read config data first to get the contracts that will be migrated
        (
            bytes4[] memory selectorsToRemove,
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _loadAndVerifyConfigData();

        // Mock contracts for testing BEFORE diamond cut
        _mockContractsForTesting(contracts);
        vm.resumeGasMetering();

        // Prepare and execute diamond cut
        LibDiamond.FacetCut[] memory cuts = _prepareDiamondCut();
        bytes memory initCallData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove,
            contracts,
            selectors
        );
        _executeDiamondCut(cuts, initCallData);

        vm.pauseGasMetering();

        // Verify final state
        _verifyFinalState(selectorsToRemove, contracts, selectors);
        vm.resumeGasMetering();
    }

    function _setupMockSwapperFacet() internal {
        mockSwapperFacet = new MockSwapperFacet();
        bytes4[] memory mockSwapperSelectors = new bytes4[](3);
        mockSwapperSelectors[0] = MockSwapperFacet
            .isContractSelectorAllowed
            .selector;
        mockSwapperSelectors[1] = MockSwapperFacet
            .isContractAllowedLegacy
            .selector;
        mockSwapperSelectors[2] = MockSwapperFacet
            .isSelectorAllowedLegacy
            .selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(mockSwapperFacet),
            mockSwapperSelectors
        );
    }

    function _getLegacyState() internal {
        // Check that the legacy approvedDexs() function exists and doesn't revert
        (bool success, bytes memory data) = DIAMOND.staticcall(
            abi.encodeWithSignature("approvedDexs()")
        );
        assertTrue(
            success,
            "Legacy approvedDexs() call should not revert before migration"
        );

        // Verify we can decode the response (should be an address array)
        address[] memory currentWhitelistedAddresses = abi.decode(
            data,
            (address[])
        );

        // Store old contracts to verify they're cleared after migration
        oldContractsBeforeMigration = currentWhitelistedAddresses;

        // Log the count for debugging
        emit log_named_uint(
            "Legacy whitelisted addresses count",
            currentWhitelistedAddresses.length
        );
    }

    function _findTestContracts(
        address[] memory contracts,
        bytes4[][] memory selectors
    )
        internal
        pure
        returns (
            address[] memory testContracts,
            bytes4[][] memory testSelectors
        )
    {
        // Find up to 5 test contracts to avoid OutOfGas errors
        // Include diverse contract types: ApproveTo-Only Selector (0xffffffff), single real selector, multiple real selectors
        uint256 maxTestContracts = contracts.length < 5 ? contracts.length : 5;

        // First pass: count how many we can find
        uint256 foundCount = 0;
        bool foundApproveToOnly = false;
        bool foundSingleReal = false;
        bool foundMultipleReal = false;

        for (
            uint256 i = 0;
            i < contracts.length && foundCount < maxTestContracts;
            i++
        ) {
            bool shouldAdd = false;

            if (
                !foundApproveToOnly &&
                selectors[i].length > 0 &&
                selectors[i][0] == bytes4(0xffffffff)
            ) {
                foundApproveToOnly = true;
                shouldAdd = true;
            } else if (
                !foundSingleReal &&
                selectors[i].length == 1 &&
                selectors[i][0] != bytes4(0xffffffff)
            ) {
                foundSingleReal = true;
                shouldAdd = true;
            } else if (!foundMultipleReal && selectors[i].length > 1) {
                foundMultipleReal = true;
                shouldAdd = true;
            } else if (foundCount < maxTestContracts) {
                // Just take any contract to reach max limit
                shouldAdd = true;
            }

            if (shouldAdd) {
                foundCount++;
            }
        }

        // If we didn't find enough, just take what we have
        if (foundCount < 2 && contracts.length >= 2) {
            foundCount = 2;
        } else if (foundCount == 0 && contracts.length > 0) {
            foundCount = 1;
        }

        // Allocate arrays
        testContracts = new address[](foundCount);
        testSelectors = new bytes4[][](foundCount);

        // Second pass: collect the contracts
        uint256 currentIndex = 0;
        foundApproveToOnly = false;
        foundSingleReal = false;
        foundMultipleReal = false;

        for (
            uint256 i = 0;
            i < contracts.length && currentIndex < foundCount;
            i++
        ) {
            bool shouldAdd = false;

            if (
                !foundApproveToOnly &&
                selectors[i].length > 0 &&
                selectors[i][0] == bytes4(0xffffffff)
            ) {
                foundApproveToOnly = true;
                shouldAdd = true;
            } else if (
                !foundSingleReal &&
                selectors[i].length == 1 &&
                selectors[i][0] != bytes4(0xffffffff)
            ) {
                foundSingleReal = true;
                shouldAdd = true;
            } else if (!foundMultipleReal && selectors[i].length > 1) {
                foundMultipleReal = true;
                shouldAdd = true;
            } else if (currentIndex < foundCount) {
                // Just take any contract to reach max limit
                shouldAdd = true;
            }

            if (shouldAdd) {
                testContracts[currentIndex] = contracts[i];
                testSelectors[currentIndex] = selectors[i];
                currentIndex++;
            }
        }
    }

    function _mockContractsForTesting(address[] memory contracts) internal {
        // Mock EXTCODESIZE for addresses from whitelist.json
        // Context: When we fork at block 33206380, some contracts from our current whitelist
        // didn't exist yet on the network. However, we still want to test the full migration
        // with all current production addresses. To do this, we mock the EXTCODESIZE opcode
        // to return a value >23 bytes for these future contracts, simulating their existence
        // at our fork block.
        for (uint256 i = 0; i < contracts.length; i++) {
            // Mock EXTCODESIZE to return >23 bytes (minimum required by LibAsset.isContract)
            vm.etch(
                contracts[i],
                hex"600180808080800180808080800180808080800180808080801b"
            ); // 32-byte dummy code
        }
    }

    function _loadAndVerifyConfigData()
        internal
        returns (
            bytes4[] memory selectorsToRemove,
            address[] memory contracts,
            bytes4[][] memory selectors
        )
    {
        // Get the calldata that will be used in the actual migration
        // This already contains the parsed and aggregated contracts/selectors
        bytes memory initCallData = deployScript.exposed_getCallData();

        // Decode the calldata to extract contracts and selectors
        // migrate(bytes4[] selectorsToRemove, address[] contracts, bytes4[][] selectors)
        (selectorsToRemove, contracts, selectors) = abi.decode(
            _sliceBytes(initCallData, 4), // Skip function selector
            (bytes4[], address[], bytes4[][])
        );

        // Log summary
        emit log_named_uint(
            "Total contracts for base network",
            contracts.length
        );
        uint256 totalSelectors = 0;
        for (uint256 i = 0; i < selectors.length; i++) {
            totalSelectors += selectors[i].length;
        }
        emit log_named_uint("Total selectors", totalSelectors);
    }

    function _sliceBytes(
        bytes memory data,
        uint256 start
    ) internal pure returns (bytes memory) {
        bytes memory result = new bytes(data.length - start);
        for (uint256 i = 0; i < result.length; i++) {
            result[i] = data[start + i];
        }
        return result;
    }

    function _setupMockSwapper(
        address approvedDex
    ) internal returns (MockSwapperFacet) {
        mockSwapperFacet = new MockSwapperFacet();
        bytes4[] memory mockSwapperSelectors = new bytes4[](1);
        mockSwapperSelectors[0] = MockSwapperFacet
            .isContractSelectorAllowed
            .selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(mockSwapperFacet),
            mockSwapperSelectors
        );

        MockSwapperFacet mockSwapper = MockSwapperFacet(DIAMOND);

        // Verify pre-migration state
        bytes4 approvedSelector = 0x38ed1739;
        assertTrue(
            mockSwapper.isContractSelectorAllowed(
                approvedDex,
                approvedSelector
            ),
            "Contract-selector pair should be allowed before migration"
        );

        return mockSwapper;
    }

    function _prepareDiamondCut()
        internal
        view
        returns (LibDiamond.FacetCut[] memory cuts)
    {
        // Build selectors array excluding migrate()
        bytes4[] memory allSelectors = new bytes4[](10);
        allSelectors[0] = WhitelistManagerFacet
            .setContractSelectorWhitelist
            .selector;
        allSelectors[1] = WhitelistManagerFacet
            .batchSetContractSelectorWhitelist
            .selector;
        allSelectors[2] = WhitelistManagerFacet
            .isContractSelectorWhitelisted
            .selector;
        allSelectors[3] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        allSelectors[4] = WhitelistManagerFacet
            .isFunctionSelectorWhitelisted
            .selector;
        allSelectors[5] = WhitelistManagerFacet.isAddressWhitelisted.selector;
        allSelectors[6] = WhitelistManagerFacet
            .getWhitelistedFunctionSelectors
            .selector;
        allSelectors[7] = WhitelistManagerFacet.isMigrated.selector;
        allSelectors[8] = WhitelistManagerFacet
            .getWhitelistedSelectorsForContract
            .selector;
        allSelectors[9] = WhitelistManagerFacet
            .getAllContractSelectorPairs
            .selector;

        // Build diamond cut
        cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(whitelistManagerWithMigrationLogic),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: allSelectors
        });
    }

    function _executeDiamondCut(
        LibDiamond.FacetCut[] memory cuts,
        bytes memory initCallData
    ) internal {
        // Verify migration hasn't happened yet
        vm.expectRevert(); // isMigrated() doesn't exist yet
        WhitelistManagerFacet(DIAMOND).isMigrated();

        // Execute diamond cut with init calldata
        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);
        DiamondCutFacet(DIAMOND).diamondCut(
            cuts,
            address(whitelistManagerWithMigrationLogic),
            initCallData
        );

        // Verify migration completed
        bool isMigrated = WhitelistManagerFacet(DIAMOND).isMigrated();
        assertTrue(
            isMigrated,
            "Migration should be completed after diamond cut"
        );
    }

    function _verifyFinalState(
        bytes4[] memory selectorsToRemove,
        address[] memory contracts,
        bytes4[][] memory selectors
    ) internal {
        // Get final state
        address[] memory finalContracts = WhitelistManagerFacet(DIAMOND)
            .getWhitelistedAddresses();

        // Verify that all expected contracts that exist are migrated
        // Note: Some contracts may not exist at the fork block and will be skipped during migration
        assertTrue(
            finalContracts.length <= contracts.length,
            "More contracts migrated than expected"
        );
        assertTrue(finalContracts.length > 0, "No contracts were migrated");

        // Verify migration completeness: all contracts migrated, V1 state set/cleared, indices initialized
        _verifyMigrationCompleteness(contracts, selectors, finalContracts);
        // Verify legacy isFunctionApproved for all selectors (unique check)
        _verifyLegacyIsFunctionApproved(selectorsToRemove, selectors);
        // Verify state consistency: mappings match arrays, reference counts correct (unique check)
        _verifyStateConsistency(finalContracts);
    }

    /// @notice Verify legacy isFunctionApproved for all selectors
    /// @dev Checks that:
    ///      1. All selectors in the whitelist return true from isFunctionApproved
    ///      2. Selectors in functionSelectorsToRemove but NOT in selectors return false
    /// @param selectorsToRemove Selectors from initCallData that were passed to migrate
    /// @param selectors Selectors from initCallData that were passed to migrate
    function _verifyLegacyIsFunctionApproved(
        bytes4[] memory selectorsToRemove,
        bytes4[][] memory selectors
    ) internal {
        // For each selector in selectors, verify isFunctionApproved returns true
        for (uint256 i = 0; i < selectors.length; i++) {
            for (uint256 j = 0; j < selectors[i].length; j++) {
                bytes4 targetSelector = selectors[i][j];

                // Verify each selector with isFunctionApproved using helper function
                // Selectors in the whitelist should be approved
                assertTrue(
                    _checkV1SelectorStorage(DIAMOND, targetSelector),
                    "Selector in whitelist should be approved"
                );
            }
        }

        // For selectors in functionSelectorsToRemove that are NOT in selectors,
        // verify they return false
        for (uint256 i = 0; i < selectorsToRemove.length; i++) {
            bytes4 selectorToRemove = selectorsToRemove[i];

            // Check if this selector is in the selectors array
            bool isInSelectors = false;
            for (uint256 j = 0; j < selectors.length; j++) {
                for (uint256 k = 0; k < selectors[j].length; k++) {
                    if (selectors[j][k] == selectorToRemove) {
                        isInSelectors = true;
                        break;
                    }
                }
                if (isInSelectors) break;
            }

            // If selector is in functionSelectorsToRemove but NOT in selectors,
            // it should return false
            if (!isInSelectors) {
                assertFalse(
                    _checkV1SelectorStorage(DIAMOND, selectorToRemove),
                    "Selector in functionSelectorsToRemove but not in selectors should return false"
                );
            }
        }
    }

    /// @notice Test that verifies a stale selector can still be removed after migration using the two-step fix
    /// @dev This test simulates the scenario where:
    ///      1. Before migration: selectorAllowList[0xBADBAD] = true (V1)
    ///      2. Before migration: contractSelectorAllowList[contract][0xBADBAD] = false (V2 source of truth)
    ///      3. Before migration: selectorToIndex[0xBADBAD] = 0 (V2)
    ///      4. After migration: The stale selector remains in V1 storage but not in V2
    ///      5. We verify the two-step fix works: add-then-remove to clear all states
    function test_SucceedsIfStaleSelectorCanBeRemovedAfterMigration() public {
        vm.pauseGasMetering();

        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Set up mock swapper to verify existing integrations
        _setupMockSwapperFacet();

        // Get current state from legacy DexManagerFacet
        _getLegacyState();

        // Read config data to get the contracts that will be migrated
        (
            bytes4[] memory selectorsToRemove,
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _loadAndVerifyConfigData();

        // Mock contracts for testing BEFORE diamond cut
        _mockContractsForTesting(contracts);

        // Create a stale selector state BEFORE migration using the old DexManagerFacet function
        // We'll use a selector that will be in selectorsToRemove but simulate it staying in V1 storage
        bytes4 staleSelector = bytes4(uint32(0xBADBAD)); // Our stale selector (padded to 4 bytes)
        address testContract = contracts.length > 0
            ? contracts[0]
            : address(0x1234);

        // Ensure testContract is a valid contract
        if (testContract == address(0) || contracts.length == 0) {
            testContract = address(0x1234567890123456789012345678901234567890);
            vm.etch(
                testContract,
                hex"600180808080800180808080800180808080800180808080801b"
            );
        }

        // Use the old DexManagerFacet.setFunctionApprovalBySignature to add selector to V1 storage
        // This creates stale state: V1 has the selector (via old function) but V2 doesn't (no contract-selector pair)
        // The diamond should already have DexManagerFacet before migration
        address owner = OwnershipFacet(DIAMOND).owner();
        vm.startPrank(owner);

        // Use the old function to add selector to V1 storage (but not V2 contract-selector pair)
        // This will only update V1 selectorAllowList, not create contract-selector pairs
        // Call setFunctionApprovalBySignature(bytes4,bool) using low-level call
        (bool success, ) = DIAMOND.call(
            abi.encodeWithSignature(
                "setFunctionApprovalBySignature(bytes4,bool)",
                staleSelector,
                true
            )
        );
        assertTrue(
            success,
            "setFunctionApprovalBySignature call should succeed"
        );
        vm.stopPrank();

        // Prepare and execute diamond cut
        LibDiamond.FacetCut[] memory cuts = _prepareDiamondCut();

        // Remove the stale selector from selectorsToRemove if it's there, so migration doesn't clear it
        bytes4[] memory adjustedSelectorsToRemove = _removeFromArray(
            selectorsToRemove,
            staleSelector
        );

        vm.resumeGasMetering();

        bytes memory initCallData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            adjustedSelectorsToRemove,
            contracts,
            selectors
        );
        _executeDiamondCut(cuts, initCallData);

        vm.pauseGasMetering();

        // Verify stale state exists after migration
        // V1 storage should still have the selector (it wasn't in selectorsToRemove anymore)
        bool v1SelectorExists = _checkV1SelectorStorage(
            DIAMOND,
            staleSelector
        );
        // V2 source of truth should be false (selector wasn't in migration data)
        bool v2SelectorExists = WhitelistManagerFacet(DIAMOND)
            .isContractSelectorWhitelisted(testContract, staleSelector);

        // The stale state should exist: V1 true, V2 false
        assertTrue(
            v1SelectorExists,
            "Stale selector should exist in V1 storage after migration"
        );
        assertFalse(
            v2SelectorExists,
            "Stale selector should NOT exist in V2 storage (source of truth)"
        );

        // Now test the two-step fix: add-then-remove
        vm.startPrank(owner);

        // Step 1: "Add" the selector to sync all states to true
        // This will make contractSelectorAllowList[testContract][staleSelector] = true
        WhitelistManagerFacet(DIAMOND).setContractSelectorWhitelist(
            testContract,
            staleSelector,
            true
        );

        // Verify after step 1: all states should be true
        assertTrue(
            WhitelistManagerFacet(DIAMOND).isContractSelectorWhitelisted(
                testContract,
                staleSelector
            ),
            "After step 1: selector should be in V2 storage"
        );
        assertTrue(
            WhitelistManagerFacet(DIAMOND).isFunctionSelectorWhitelisted(
                staleSelector
            ),
            "After step 1: selector should be in V1 storage"
        );

        // Verify that DexManagerFacet's isFunctionApproved also returns true
        // (DexManagerFacet is still on the diamond, so we should verify V1 storage is synced)
        assertTrue(
            _checkV1SelectorStorage(DIAMOND, staleSelector),
            "After step 1: isFunctionApproved should return true (V1 storage synced)"
        );

        // Step 2: "Remove" the selector to clear all states
        WhitelistManagerFacet(DIAMOND).setContractSelectorWhitelist(
            testContract,
            staleSelector,
            false
        );

        // Verify after step 2: all states should be cleared
        assertFalse(
            WhitelistManagerFacet(DIAMOND).isContractSelectorWhitelisted(
                testContract,
                staleSelector
            ),
            "After step 2: selector should NOT be in V2 storage"
        );
        assertFalse(
            WhitelistManagerFacet(DIAMOND).isFunctionSelectorWhitelisted(
                staleSelector
            ),
            "After step 2: selector should NOT be in V1 storage"
        );

        // Verify that DexManagerFacet's isFunctionApproved also returns false
        // (DexManagerFacet is still on the diamond, so we should verify V1 storage is cleared)
        assertFalse(
            _checkV1SelectorStorage(DIAMOND, staleSelector),
            "After step 2: isFunctionApproved should return false (V1 storage cleared)"
        );

        vm.stopPrank();

        vm.resumeGasMetering();
    }

    /// @notice Helper function to check if a selector exists in V1 storage
    function _checkV1SelectorStorage(
        address diamond,
        bytes4 selector
    ) internal returns (bool) {
        // call isFunctionApproved on DexManagerFacet
        (bool success, bytes memory data) = diamond.staticcall(
            abi.encodeWithSignature("isFunctionApproved(bytes4)", selector)
        );
        assertTrue(success, "isFunctionApproved call should not revert");
        bool isSelectorApproved = abi.decode(data, (bool));
        return isSelectorApproved;
    }

    /// @notice Helper function to remove an element from a bytes4 array
    function _removeFromArray(
        bytes4[] memory arr,
        bytes4 element
    ) internal pure returns (bytes4[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] != element) {
                count++;
            }
        }

        if (count == arr.length) {
            return arr; // Element not found, return original
        }

        bytes4[] memory result = new bytes4[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] != element) {
                result[j] = arr[i];
                j++;
            }
        }
        return result;
    }

    /// @notice Verify migration completeness: V1 state cleared, indices initialized
    /// @dev Checks that:
    ///      1. All migrated contracts have V1 contractAllowList set correctly
    ///      2. All migrated selectors have V1 selectorAllowList set correctly
    ///      3. V2 indices (contractToIndex, selectorToIndex) are properly initialized
    ///      4. All migrated data is immediately queryable via getter functions
    ///      5. Expected contracts that were successfully migrated are in finalContracts
    ///      6. Old V1 state is properly cleared (contracts and selectors not in migration)
    function _verifyMigrationCompleteness(
        address[] memory expectedContracts,
        bytes4[][] memory expectedSelectors,
        address[] memory finalContracts
    ) internal {
        // Verify old V1 state is cleared for contracts that existed before migration but weren't migrated
        _verifyV1StateCleared(expectedContracts, finalContracts);
        // Verify all expected contracts that were successfully migrated are in finalContracts
        for (uint256 i = 0; i < finalContracts.length; i++) {
            address contractAddr = finalContracts[i];

            // Verify this final contract was in the expected contracts list
            bool foundInExpected = false;
            for (uint256 j = 0; j < expectedContracts.length; j++) {
                if (expectedContracts[j] == contractAddr) {
                    foundInExpected = true;
                    break;
                }
            }
            assertTrue(
                foundInExpected,
                "Final contract should be in expected contracts list"
            );

            // Verify contract is queryable via getter
            assertTrue(
                WhitelistManagerFacet(DIAMOND).isAddressWhitelisted(
                    contractAddr
                ),
                "Migrated contract should be queryable via isAddressWhitelisted"
            );

            // Verify V1 contractAllowList is set (via legacy check)
            (bool success, ) = DIAMOND.staticcall(
                abi.encodeWithSignature(
                    "isFunctionApproved(bytes4)",
                    bytes4(0)
                )
            );
            assertTrue(success, "DexManagerFacet should exist");
            // DexManagerFacet exists, verify via MockSwapper
            assertTrue(
                MockSwapperFacet(DIAMOND).isContractAllowedLegacy(
                    contractAddr
                ),
                "Migrated contract should have V1 contractAllowList set"
            );

            // Verify contract selector pairs are properly set
            // Find the corresponding selectors for this contract
            for (uint256 k = 0; k < expectedContracts.length; k++) {
                if (expectedContracts[k] == contractAddr) {
                    bytes4[] memory contractSelectors = expectedSelectors[k];

                    if (contractSelectors.length == 0) {
                        // Contract with no callable functions uses ApproveTo-Only Selector (0xffffffff)
                        assertTrue(
                            WhitelistManagerFacet(DIAMOND)
                                .isContractSelectorWhitelisted(
                                    contractAddr,
                                    bytes4(0xffffffff)
                                ),
                            "Contract with no callable functions should have ApproveTo-Only Selector whitelisted"
                        );

                        // Verify legacy selector check
                        assertTrue(
                            MockSwapperFacet(DIAMOND).isSelectorAllowedLegacy(
                                bytes4(0xffffffff)
                            ),
                            "ApproveTo-Only Selector should be allowed via legacy check"
                        );
                    } else {
                        // Verify each selector for this contract
                        for (
                            uint256 j = 0;
                            j < contractSelectors.length;
                            j++
                        ) {
                            bytes4 selector = contractSelectors[j];

                            // Verify contract-selector pair via facet
                            assertTrue(
                                WhitelistManagerFacet(DIAMOND)
                                    .isContractSelectorWhitelisted(
                                        contractAddr,
                                        selector
                                    ),
                                "Contract-selector pair should be whitelisted"
                            );

                            // Verify contract selector pair via library (mock swapper integration check)
                            assertTrue(
                                MockSwapperFacet(DIAMOND)
                                    .isContractSelectorAllowed(
                                        contractAddr,
                                        selector
                                    ),
                                "Contract-selector pair should be allowed via library check"
                            );
                        }
                    }
                    break;
                }
            }
        }

        // Collect all unique selectors from expectedSelectors
        bytes4[] memory uniqueSelectors = new bytes4[](256);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < expectedSelectors.length; i++) {
            for (uint256 j = 0; j < expectedSelectors[i].length; j++) {
                bytes4 selector = expectedSelectors[i][j];

                // Check if already collected
                bool found = false;
                for (uint256 k = 0; k < uniqueCount; k++) {
                    if (uniqueSelectors[k] == selector) {
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    uniqueSelectors[uniqueCount] = selector;
                    uniqueCount++;
                }
            }
        }

        // Verify all unique selectors have V1 state set and are queryable
        bytes4[] memory allSelectors = WhitelistManagerFacet(DIAMOND)
            .getWhitelistedFunctionSelectors();

        for (uint256 i = 0; i < uniqueCount; i++) {
            bytes4 selector = uniqueSelectors[i];

            // Verify selector is in the final whitelist
            bool found = false;
            for (uint256 j = 0; j < allSelectors.length; j++) {
                if (allSelectors[j] == selector) {
                    found = true;
                    break;
                }
            }
            assertTrue(
                found,
                "Migrated selector should be in final whitelist"
            );

            // Verify selector is queryable
            assertTrue(
                WhitelistManagerFacet(DIAMOND).isFunctionSelectorWhitelisted(
                    selector
                ),
                "Migrated selector should be queryable via isFunctionSelectorWhitelisted"
            );
        }
    }

    /// @notice Verify that old V1 state is properly cleared for contracts not in migration
    /// @dev Checks that contracts that existed before migration but weren't migrated have V1 state cleared
    function _verifyV1StateCleared(
        address[] memory expectedContracts,
        address[] memory finalContracts
    ) internal {
        // Check if DexManagerFacet exists to verify legacy state
        (bool success, ) = DIAMOND.staticcall(
            abi.encodeWithSignature("isFunctionApproved(bytes4)", bytes4(0))
        );
        assertTrue(success, "DexManagerFacet should exist");

        // For each old contract, verify it's either migrated or cleared
        for (uint256 i = 0; i < oldContractsBeforeMigration.length; i++) {
            address oldContract = oldContractsBeforeMigration[i];

            // Check if this contract was migrated
            bool wasMigrated = false;
            for (uint256 j = 0; j < finalContracts.length; j++) {
                if (finalContracts[j] == oldContract) {
                    wasMigrated = true;
                    break;
                }
            }

            // Check if contract was in expected contracts (should be migrated)
            bool wasExpected = false;
            for (uint256 j = 0; j < expectedContracts.length; j++) {
                if (expectedContracts[j] == oldContract) {
                    wasExpected = true;
                    break;
                }
            }

            // If contract was expected but not migrated, it means it didn't exist at fork block
            // (which is expected and acceptable)
            // If contract was NOT expected, it should have been cleared from V1 state
            if (!wasExpected && !wasMigrated) {
                // This contract existed before migration but wasn't in migration data
                // Verify it was cleared from V1 state - should not be in finalContracts
                assertFalse(
                    WhitelistManagerFacet(DIAMOND).isAddressWhitelisted(
                        oldContract
                    ),
                    "Old contract not in migration should be cleared from whitelist"
                );

                // Verify V1 contractAllowList is cleared via legacy check
                assertFalse(
                    MockSwapperFacet(DIAMOND).isContractAllowedLegacy(
                        oldContract
                    ),
                    "Old contract not in migration should have V1 state cleared"
                );
            }
        }
    }

    /// @notice Verify state consistency: mappings match arrays, reference counts correct
    /// @dev Checks that:
    ///      1. contractToIndex[contract] points to correct position in contracts array
    ///      2. selectorToIndex[selector] points to correct position in selectors array
    ///      3. selectorReferenceCount matches actual usage
    ///      4. whitelistedSelectorsByContract matches contractSelectorAllowList
    ///      5. Arrays and mappings are synchronized
    function _verifyStateConsistency(address[] memory contracts) internal {
        bytes4[] memory selectors = WhitelistManagerFacet(DIAMOND)
            .getWhitelistedFunctionSelectors();

        // Verify contractToIndex consistency
        // Note: We can't directly access contractToIndex mapping without storage access,
        // but we verify indirectly that the index mapping is correct by checking that:
        // 1. getAllContractSelectorPairs returns contracts in the same order as getWhitelistedAddresses
        // 2. Each contract in the contracts array appears exactly once in getAllContractSelectorPairs
        // 3. The position of each contract in getAllContractSelectorPairs matches its position in contracts
        (
            address[] memory allContracts1,
            bytes4[][] memory allSelectors1
        ) = WhitelistManagerFacet(DIAMOND).getAllContractSelectorPairs();

        // Verify arrays have same length
        assertEq(
            allContracts1.length,
            contracts.length,
            "getAllContractSelectorPairs should return same number of contracts as getWhitelistedAddresses"
        );

        for (uint256 i = 0; i < contracts.length; i++) {
            address contractAddr = contracts[i];

            // Verify the contract appears at the expected position (contractToIndex consistency)
            // Since contracts array and getAllContractSelectorPairs should be in same order,
            // we verify that each contract appears at the correct index
            // This indirectly verifies that contractToIndex[contract] points to the correct position
            assertEq(
                allContracts1[i],
                contracts[i],
                "Contract should be at same index in both arrays (contractToIndex consistency)"
            );

            // Verify getWhitelistedSelectorsForContract matches the returned selectors
            bytes4[] memory contractSelectors = WhitelistManagerFacet(DIAMOND)
                .getWhitelistedSelectorsForContract(contractAddr);
            assertEq(
                contractSelectors.length,
                allSelectors1[i].length,
                "getWhitelistedSelectorsForContract should match getAllContractSelectorPairs"
            );

            // Verify all selectors for this contract are queryable
            for (uint256 j = 0; j < contractSelectors.length; j++) {
                assertTrue(
                    WhitelistManagerFacet(DIAMOND)
                        .isContractSelectorWhitelisted(
                            contractAddr,
                            contractSelectors[j]
                        ),
                    "Selector should be queryable for contract"
                );
            }
        }

        // Verify selectorReferenceCount consistency
        // Each selector should appear in selectors array if it's used by at least one contract
        for (uint256 i = 0; i < selectors.length; i++) {
            bytes4 selector = selectors[i];

            // Verify selector is used by at least one contract
            bool foundUsage = false;
            for (uint256 j = 0; j < contracts.length; j++) {
                bytes4[] memory contractSelectors = WhitelistManagerFacet(
                    DIAMOND
                ).getWhitelistedSelectorsForContract(contracts[j]);

                for (uint256 k = 0; k < contractSelectors.length; k++) {
                    if (contractSelectors[k] == selector) {
                        foundUsage = true;
                        break;
                    }
                }
                if (foundUsage) break;
            }
            assertTrue(
                foundUsage,
                "Selector in selectors array should be used by at least one contract"
            );

            // Verify selector appears exactly once in selectors array
            uint256 countInArray = 0;
            for (uint256 j = 0; j < selectors.length; j++) {
                if (selectors[j] == selector) {
                    countInArray++;
                }
            }
            assertEq(
                countInArray,
                1,
                "Selector should appear exactly once in selectors array"
            );
        }

        // Verify no duplicate contracts in contracts array
        for (uint256 i = 0; i < contracts.length; i++) {
            uint256 count = 0;
            for (uint256 j = 0; j < contracts.length; j++) {
                if (contracts[j] == contracts[i]) {
                    count++;
                }
            }
            assertEq(
                count,
                1,
                "Contract should appear exactly once in contracts array"
            );
        }

        // Verify getAllContractSelectorPairs consistency
        (address[] memory allContracts2, ) = WhitelistManagerFacet(DIAMOND)
            .getAllContractSelectorPairs();

        assertEq(
            allContracts2.length,
            contracts.length,
            "getAllContractSelectorPairs should return same number of contracts"
        );

        // Verify each contract in getAllContractSelectorPairs matches getWhitelistedAddresses
        for (uint256 i = 0; i < allContracts2.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < contracts.length; j++) {
                if (contracts[j] == allContracts2[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(
                found,
                "Contract in getAllContractSelectorPairs should be in getWhitelistedAddresses"
            );
        }
    }
}

contract ExposedUpdateWhitelistManagerFacetDeployScript is DeployScript {
    function exposed_getCallData() public returns (bytes memory) {
        return getCallData();
    }
}
