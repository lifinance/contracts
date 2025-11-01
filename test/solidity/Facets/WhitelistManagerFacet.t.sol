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

    event AddressWhitelisted(address indexed whitelistedAddress);
    event AddressRemoved(address indexed removedAddress);
    event FunctionSelectorWhitelistChanged(
        bytes4 indexed functionSelector,
        bool indexed approved
    );
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

    function setUp() public {
        // fork mainnet to test with real production state
        string memory rpcUrl = vm.envString("ETH_NODE_URI_BASE");
        vm.createSelectFork(rpcUrl, 33206380);

        // Set required environment variables for deployment script
        vm.setEnv("NETWORK", "base");
        vm.setEnv("FILE_SUFFIX", "staging.");
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
        // Deploy WhitelistManagerFacet first
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // Set up mock swapper to verify existing integrations
        _setupMockSwapperFacet();

        // Get current state from legacy DexManagerFacet (call in order to check )
        _getLegacyState();

        // Read config data first to get the contracts that will be migrated
        (
            address[] memory contracts,
            bytes4[][] memory selectors
        ) = _loadAndVerifyConfigData();

        // Find test contracts (at least 2) for verification
        (
            address[] memory testContracts,
            bytes4[][] memory testSelectors
        ) = _findTestContracts(contracts, selectors);

        // Mock contracts for testing BEFORE diamond cut
        _mockContractsForTesting(contracts);

        // Prepare and execute diamond cut
        LibDiamond.FacetCut[] memory cuts = _prepareDiamondCut();
        // Build calldata ourselves to ensure we use the corrected selectors
        bytes4[] memory selectorsToRemove = _readSelectorsToRemoveForTest();
        bytes memory initCallData = abi.encodeWithSelector(
            WhitelistManagerFacet.migrate.selector,
            selectorsToRemove,
            contracts,
            selectors
        );
        _executeDiamondCut(cuts, initCallData);

        // Verify final state
        _verifyFinalState(contracts, selectors, testContracts, testSelectors);
    }

    function _readSelectorsToRemoveForTest()
        internal
        returns (bytes4[] memory out)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/functionSelectorsToRemove.json"
        );
        string memory json = vm.readFile(path);
        string[] memory raw = vm.parseJsonStringArray(
            json,
            ".functionSelectorsToRemove"
        );
        out = new bytes4[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            out[i] = bytes4(vm.parseBytes(raw[i]));
        }
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
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // Increase gas limit for parsing
        vm.pauseGasMetering();

        // Get the calldata that will be used in the actual migration
        // This already contains the parsed and aggregated contracts/selectors
        bytes memory initCallData = deployScript.exposed_getCallData();

        vm.resumeGasMetering();

        // Decode the calldata to extract contracts and selectors
        // migrate(bytes4[] selectorsToRemove, address[] contracts, bytes4[][] selectors)
        (
            ,
            // Skip selectorsToRemove
            contracts,
            selectors
        ) = abi.decode(
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
        bytes4[] memory allSelectors = new bytes4[](8);
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
        address[] memory contracts,
        bytes4[][] memory selectors,
        address[] memory testContracts,
        bytes4[][] memory testSelectors
    ) internal {
        MockSwapperFacet mockSwapper = MockSwapperFacet(DIAMOND);

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

        // Verify each contract is correctly migrated
        _verifyContractMigration(contracts, selectors, finalContracts);

        // Verify test contracts specifically
        _verifyTestContracts(testContracts, testSelectors, mockSwapper);
    }

    function _verifyContractMigration(
        address[] memory contracts,
        bytes4[][] memory selectors,
        address[] memory finalContracts
    ) internal {
        for (uint256 i = 0; i < contracts.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < finalContracts.length; j++) {
                if (finalContracts[j] == contracts[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "Contract not found in final whitelist");

            // Verify contract-selector pairs are properly set
            _verifyContractSelectors(contracts[i], selectors[i]);
        }
    }

    function _verifyContractSelectors(
        address contractAddr,
        bytes4[] memory contractSelectors
    ) internal {
        if (contractSelectors.length == 0) {
            // Contract with no callable functions uses ApproveTo-Only Selector (0xffffffff).
            assertTrue(
                WhitelistManagerFacet(DIAMOND).isContractSelectorWhitelisted(
                    contractAddr,
                    bytes4(0xffffffff)
                ),
                "Contract with no callable functions should have ApproveTo-Only Selector whitelisted"
            );
        } else {
            // Verify each selector for this contract
            for (uint256 k = 0; k < contractSelectors.length; k++) {
                assertTrue(
                    WhitelistManagerFacet(DIAMOND)
                        .isContractSelectorWhitelisted(
                            contractAddr,
                            contractSelectors[k]
                        ),
                    "Contract-selector pair not whitelisted"
                );
            }
        }
    }

    function _verifyTestContracts(
        address[] memory testContracts,
        bytes4[][] memory testSelectors,
        MockSwapperFacet mockSwapper
    ) internal {
        // Verify each test contract
        for (uint256 i = 0; i < testContracts.length; i++) {
            address testContract = testContracts[i];
            bytes4[] memory contractSelectors = testSelectors[i];

            // Verify contract is in whitelist
            assertTrue(
                WhitelistManagerFacet(DIAMOND).isAddressWhitelisted(
                    testContract
                ),
                "Test contract should be whitelisted"
            );

            // Verify legacy compatibility - contract should be allowed
            assertTrue(
                mockSwapper.isContractAllowedLegacy(testContract),
                "Test contract should be allowed via legacy check"
            );

            // Verify each selector for this contract
            if (
                contractSelectors.length == 0 ||
                contractSelectors[0] == bytes4(0xffffffff)
            ) {
                // Contract with ApproveTo-Only Selector (0xffffffff)
                assertTrue(
                    WhitelistManagerFacet(DIAMOND)
                        .isContractSelectorWhitelisted(
                            testContract,
                            bytes4(0xffffffff)
                        ),
                    "ApproveTo-Only Selector should be whitelisted"
                );

                // Verify legacy selector check returns true for ApproveTo-Only Selector
                assertTrue(
                    mockSwapper.isSelectorAllowedLegacy(bytes4(0xffffffff)),
                    "ApproveTo-Only Selector should be allowed via legacy check"
                );
            } else {
                // Contract with real selectors
                for (uint256 j = 0; j < contractSelectors.length; j++) {
                    bytes4 selector = contractSelectors[j];

                    // Verify granular contract-selector whitelist
                    assertTrue(
                        mockSwapper.isContractSelectorAllowed(
                            testContract,
                            selector
                        ),
                        "Contract-selector pair should be allowed"
                    );

                    // Verify selector is whitelisted
                    assertTrue(
                        WhitelistManagerFacet(DIAMOND)
                            .isContractSelectorWhitelisted(
                                testContract,
                                selector
                            ),
                        "Selector should be whitelisted for contract"
                    );

                    // Verify legacy contract check
                    assertTrue(
                        mockSwapper.isContractAllowedLegacy(testContract),
                        "Contract should be allowed via legacy check"
                    );

                    // Verify legacy selector check
                    assertTrue(
                        mockSwapper.isSelectorAllowedLegacy(selector),
                        "Selector should be allowed via legacy check"
                    );
                }
            }
        }
    }
}

contract ExposedUpdateWhitelistManagerFacetDeployScript is DeployScript {
    function exposed_getCallData() public returns (bytes memory) {
        return getCallData();
    }
}
