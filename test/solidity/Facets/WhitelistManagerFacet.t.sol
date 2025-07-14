// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { OwnershipFacet } from "src/Facets/OwnershipFacet.sol";
import { InvalidContract, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { IDexManagerFacet } from "lifi/Interfaces/IDexManagerFacet.sol";
import { TestBase } from "../utils/TestBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract Foo {}

/// @title Mock Swapper Facet
/// @notice Mock facet that simulates SwapperV2 allow list logic for testing
contract MockSwapperFacet {
    /// @notice Simple function to test if a contract is allowed
    /// @param _contract The contract address to check
    function isContractAllowed(
        address _contract
    ) external view returns (bool) {
        return LibAllowList.contractIsAllowed(_contract);
    }

    /// @notice Simple function to test if a selector is allowed
    /// @param _selector The selector to check
    function isSelectorAllowed(bytes4 _selector) external view returns (bool) {
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

    event AddressWhitelisted(address indexed whitelistedAddress);
    event AddressRemoved(address indexed removedAddress);
    event FunctionSelectorApprovalChanged(
        bytes4 indexed functionSelector,
        bool indexed approved
    );

    function setUp() public {
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        whitelistMgr = new WhitelistManagerFacet();
        c1 = new Foo();
        c2 = new Foo();
        c3 = new Foo();

        bytes4[] memory functionSelectors = new bytes4[](10);
        functionSelectors[0] = WhitelistManagerFacet.addToWhitelist.selector;
        functionSelectors[1] = WhitelistManagerFacet
            .removeFromWhitelist
            .selector;
        functionSelectors[2] = WhitelistManagerFacet
            .batchAddToWhitelist
            .selector;
        functionSelectors[3] = WhitelistManagerFacet
            .batchRemoveFromWhitelist
            .selector;
        functionSelectors[4] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        functionSelectors[5] = WhitelistManagerFacet
            .setFunctionApprovalBySelector
            .selector;
        functionSelectors[6] = WhitelistManagerFacet
            .batchSetFunctionApprovalBySelector
            .selector;
        functionSelectors[7] = WhitelistManagerFacet
            .isFunctionApproved
            .selector;
        functionSelectors[8] = WhitelistManagerFacet
            .isAddressWhitelisted
            .selector;
        functionSelectors[9] = WhitelistManagerFacet
            .getApprovedFunctionSelectors
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
        emit AddressWhitelisted(address(c1));

        whitelistMgr.addToWhitelist(address(c1));
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved[0], address(c1));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerRemovesAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        whitelistMgr.addToWhitelist(address(c1));

        vm.expectEmit(true, true, true, true);
        emit AddressRemoved(address(c1));

        whitelistMgr.removeFromWhitelist(address(c1));

        vm.stopPrank();

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 0);
    }

    function _batchAddAddresses(address[] memory addresses) internal {
        for (uint256 i = 0; i < addresses.length; i++) {
            vm.expectEmit(true, true, true, true);
            emit AddressWhitelisted(addresses[i]);
        }
        whitelistMgr.batchAddToWhitelist(addresses);

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

        _batchAddAddresses(addresses);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchRemovesAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);
        _batchAddAddresses(addresses);

        address[] memory remove = new address[](2);
        remove[0] = address(c1);
        remove[1] = address(c2);
        whitelistMgr.batchRemoveFromWhitelist(remove);

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 1);
        assertEq(approved[0], addresses[2]);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerApprovesFunctionSelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";

        vm.expectEmit(true, true, true, true);
        emit FunctionSelectorApprovalChanged(selector, true);

        whitelistMgr.setFunctionApprovalBySelector(selector, true);
        assertTrue(whitelistMgr.isFunctionApproved(selector));

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
        whitelistMgr.batchSetFunctionApprovalBySelector(selectors, true);
        for (uint256 i = 0; i < 5; ) {
            assertTrue(whitelistMgr.isFunctionApproved(selectors[i]));
            unchecked {
                ++i;
            }
        }

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.addToWhitelist(address(0));

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingAddressThatIsNotAContract() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.addToWhitelist(address(1337));

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchAddingWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(0);

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.batchAddToWhitelist(addresses);

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

        vm.expectRevert(InvalidContract.selector);

        whitelistMgr.batchAddToWhitelist(addresses);

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToAddAddress() public {
        vm.startPrank(NOT_DIAMOND_OWNER); // prank a non-owner to attempt adding an address

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.addToWhitelist(address(c1));

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToBatchAddAddresses() public {
        vm.startPrank(NOT_DIAMOND_OWNER);
        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(c2);

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.batchAddToWhitelist(addresses);

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingAddressThatIsWhitelistManager() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(whitelistMgr); // contract itself

        vm.expectRevert(CannotAuthoriseSelf.selector);

        whitelistMgr.batchAddToWhitelist(addresses);

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToRemoveAddress() public {
        vm.prank(USER_DIAMOND_OWNER);

        whitelistMgr.addToWhitelist(address(c1));

        vm.stopPrank();

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.removeFromWhitelist(address(c1));
    }

    function testRevert_FailsIfNonOwnerTriesToBatchRemoveAddresses() public {
        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(c2);

        vm.prank(USER_DIAMOND_OWNER);
        whitelistMgr.batchAddToWhitelist(addresses);

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchRemoveFromWhitelist(addresses);
    }

    function testRevert_FailsIfNonOwnerTriesToSetFunctionApprovalBySelector()
        public
    {
        bytes4 selector = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.setFunctionApprovalBySelector(selector, true);
    }

    function testRevert_FailsIfNonOwnerTriesToBatchSetFunctionApprovalBySelector()
        public
    {
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchSetFunctionApprovalBySelector(selectors, true);
    }

    function test_SucceedsIfOwnerSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";

        whitelistMgr.setFunctionApprovalBySelector(selector, true);
        assertTrue(whitelistMgr.isFunctionApproved(selector));

        whitelistMgr.setFunctionApprovalBySelector(selector, false);
        assertFalse(whitelistMgr.isFunctionApproved(selector));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySelector(selectors, true);
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(whitelistMgr.isFunctionApproved(selectors[i]));
        }

        whitelistMgr.batchSetFunctionApprovalBySelector(selectors, false);
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(whitelistMgr.isFunctionApproved(selectors[i]));
        }

        vm.stopPrank();
    }

    function test_AllowsWhitelistedAddressToAddContract() public {
        vm.startPrank(USER_PAUSER);
        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.addToWhitelist(address(c1));

        // allow USER_PAUSER address to execute addToWhitelist() function
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            WhitelistManagerFacet.addToWhitelist.selector,
            USER_PAUSER,
            true
        );

        whitelistMgr.addToWhitelist(address(c1));

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();

        assertEq(approved[0], address(c1));
    }

    function test_AllowsWhitelistedAddressToBatchAddAddresses() public {
        address[] memory addresses = new address[](2);
        addresses[0] = address(c1);
        addresses[1] = address(c2);

        vm.stopPrank();
        vm.startPrank(USER_PAUSER);

        vm.expectRevert(UnAuthorized.selector);

        whitelistMgr.batchAddToWhitelist(addresses);

        // allow USER_PAUSER address to execute batchAddToWhitelist() function
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            WhitelistManagerFacet.batchAddToWhitelist.selector,
            USER_PAUSER,
            true
        );

        // try to call batchAddToWhitelist()
        vm.startPrank(USER_PAUSER);

        whitelistMgr.batchAddToWhitelist(addresses);

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();

        assertEq(approved[0], address(c1));
        assertEq(approved[1], address(c2));
    }

    function test_BatchAddKeepsAlreadyApprovedAddressAndAddsNewOnes() public {
        address[] memory addresses = new address[](1);
        addresses[0] = address(c2);

        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            WhitelistManagerFacet.batchAddToWhitelist.selector,
            USER_PAUSER,
            true
        );

        // try to call addToWhitelist()
        vm.startPrank(USER_PAUSER);

        whitelistMgr.batchAddToWhitelist(addresses);

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();

        assertEq(approved[0], address(c2));

        addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2); // already whitelisted
        addresses[2] = address(c3);

        whitelistMgr.batchAddToWhitelist(addresses);

        approved = whitelistMgr.getWhitelistedAddresses();

        assertEq(approved[0], address(c2));
        assertEq(approved[1], address(c1));
        assertEq(approved[2], address(c3));
    }

    function test_SucceedsIfNoApprovedSelectorsReturnsEmptyArray() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 0);

        vm.stopPrank();
    }

    function test_SucceedsIfSingleApprovedSelectorIsReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";
        whitelistMgr.setFunctionApprovalBySelector(selector, true);

        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 1);
        assertEq(selectors[0], selector);

        vm.stopPrank();
    }

    function test_SucceedsIfMultipleApprovedSelectorsAreReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSelectors = new bytes4[](3);
        testSelectors[0] = bytes4(hex"faceface");
        testSelectors[1] = bytes4(hex"deadbeef");
        testSelectors[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySelector(testSelectors, true);

        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 3);

        bool foundSel0 = false;
        bool foundSel1 = false;
        bool foundSel2 = false;

        for (uint256 i = 0; i < selectors.length; i++) {
            if (selectors[i] == testSelectors[0]) foundSel0 = true;
            if (selectors[i] == testSelectors[1]) foundSel1 = true;
            if (selectors[i] == testSelectors[2]) foundSel2 = true;
        }

        assertTrue(foundSel0);
        assertTrue(foundSel1);
        assertTrue(foundSel2);

        vm.stopPrank();
    }

    function test_SucceedsIfRemovedSelectorsAreNotReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSelectors = new bytes4[](3);
        testSelectors[0] = bytes4(hex"faceface");
        testSelectors[1] = bytes4(hex"deadbeef");
        testSelectors[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySelector(testSelectors, true);

        // Remove the middle selector
        whitelistMgr.setFunctionApprovalBySelector(testSelectors[1], false);

        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 2);

        bool foundSel0 = false;
        bool foundSel1 = false;
        bool foundSel2 = false;

        for (uint256 i = 0; i < selectors.length; i++) {
            if (selectors[i] == testSelectors[0]) foundSel0 = true;
            if (selectors[i] == testSelectors[1]) foundSel1 = true;
            if (selectors[i] == testSelectors[2]) foundSel2 = true;
        }

        assertTrue(foundSel0);
        assertFalse(foundSel1); // This should not be found
        assertTrue(foundSel2);

        vm.stopPrank();
    }

    function test_SucceedsIfBatchRemovedSelectorsAreNotReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSelectors = new bytes4[](5);
        testSelectors[0] = bytes4(hex"faceface");
        testSelectors[1] = bytes4(hex"deadbeef");
        testSelectors[2] = bytes4(hex"beefbeef");
        testSelectors[3] = bytes4(hex"beefdead");
        testSelectors[4] = bytes4(hex"facedead");

        whitelistMgr.batchSetFunctionApprovalBySelector(testSelectors, true);

        bytes4[] memory removeSelectors = new bytes4[](3);
        removeSelectors[0] = testSelectors[1]; // deadbeef
        removeSelectors[1] = testSelectors[3]; // beefdead
        removeSelectors[2] = testSelectors[4]; // facedead

        whitelistMgr.batchSetFunctionApprovalBySelector(
            removeSelectors,
            false
        );

        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 2);

        // Expected remaining: faceface (0) and beefbeef (2)
        bool foundSel0 = false;
        bool foundSel2 = false;

        for (uint256 i = 0; i < selectors.length; i++) {
            if (selectors[i] == testSelectors[0]) foundSel0 = true;
            if (selectors[i] == testSelectors[2]) foundSel2 = true;
        }

        assertTrue(foundSel0);
        assertTrue(foundSel2);

        vm.stopPrank();
    }

    function test_SucceedsIfRemovingNonWhitelistedAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Try to remove an address that was never whitelisted
        whitelistMgr.removeFromWhitelist(address(c1));

        // Add a different address to whitelist
        whitelistMgr.addToWhitelist(address(c2));

        // Verify the state is correct
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 1);
        assertEq(approved[0], address(c2));

        vm.stopPrank();
    }

    function test_SucceedsIfRemovingNonApprovedSelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Add one selector
        bytes4 selector1 = bytes4(hex"faceface");
        whitelistMgr.setFunctionApprovalBySelector(selector1, true);

        // Try to remove a different selector that was never approved
        bytes4 selector2 = bytes4(hex"deadbeef");
        whitelistMgr.setFunctionApprovalBySelector(selector2, false);

        // Verify the state is correct
        bytes4[] memory selectors = whitelistMgr
            .getApprovedFunctionSelectors();
        assertEq(selectors.length, 1);
        assertEq(selectors[0], selector1);

        vm.stopPrank();
    }

    function test_SucceedsIfAddressIsWhitelisted() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        whitelistMgr.addToWhitelist(address(c1));

        assertTrue(whitelistMgr.isAddressWhitelisted(address(c1)));

        vm.stopPrank();
    }

    function test_SucceedsIfAddressIsNotWhitelisted() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        assertFalse(whitelistMgr.isAddressWhitelisted(address(c1)));

        vm.stopPrank();
    }

    function test_SucceedsIfZeroAddressIsNotWhitelisted() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        assertFalse(whitelistMgr.isAddressWhitelisted(address(0)));

        vm.stopPrank();
    }

    function test_SucceedsIfWhitelistStateChangesAreReflected() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        assertFalse(whitelistMgr.isAddressWhitelisted(address(c1)));

        whitelistMgr.addToWhitelist(address(c1));
        assertTrue(whitelistMgr.isAddressWhitelisted(address(c1)));

        whitelistMgr.removeFromWhitelist(address(c1));
        assertFalse(whitelistMgr.isAddressWhitelisted(address(c1)));

        vm.stopPrank();
    }

    function test_SucceedsIfContractIndexMappingIsCorrect() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Add first contract
        whitelistMgr.addToWhitelist(address(c1));
        assertTrue(whitelistMgr.isAddressWhitelisted(address(c1)));

        // Add second contract
        whitelistMgr.addToWhitelist(address(c2));
        assertTrue(whitelistMgr.isAddressWhitelisted(address(c2)));

        // Get all addresses to verify order
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 2);
        assertEq(approved[0], address(c1)); // Should be at index 1 (1-based)
        assertEq(approved[1], address(c2)); // Should be at index 2 (1-based)

        // Remove first contract
        whitelistMgr.removeFromWhitelist(address(c1));

        // Verify c2 was moved to index 0
        approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 1);
        assertEq(approved[0], address(c2));

        vm.stopPrank();
    }

    function test_SucceedsIfSelectorIndexMappingIsCorrect() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector1 = hex"faceface";
        bytes4 selector2 = hex"deadbeef";
        bytes4 selector3 = hex"cafecafe";

        whitelistMgr.setFunctionApprovalBySelector(selector1, true);
        assertTrue(whitelistMgr.isFunctionApproved(selector1));

        whitelistMgr.setFunctionApprovalBySelector(selector2, true);
        assertTrue(whitelistMgr.isFunctionApproved(selector2));

        whitelistMgr.setFunctionApprovalBySelector(selector3, true);
        assertTrue(whitelistMgr.isFunctionApproved(selector3));

        // get all selectors to verify order
        bytes4[] memory approved = whitelistMgr.getApprovedFunctionSelectors();
        assertEq(approved.length, 3);
        assertEq(approved[0], selector1);
        assertEq(approved[1], selector2);
        assertEq(approved[2], selector3);

        // remove first selector
        whitelistMgr.setFunctionApprovalBySelector(selector2, false);

        // verify selector3 was moved to index 1
        approved = whitelistMgr.getApprovedFunctionSelectors();
        assertEq(approved.length, 2);
        assertEq(approved[0], selector1);
        assertEq(approved[1], selector3);

        vm.stopPrank();
    }

    function test_SucceedsIfBatchAddingMaintainsCorrectIndices() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);

        whitelistMgr.batchAddToWhitelist(addresses);

        for (uint256 i = 0; i < addresses.length; i++) {
            assertTrue(whitelistMgr.isAddressWhitelisted(addresses[i]));
        }

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 3);
        assertEq(approved[0], address(c1));
        assertEq(approved[1], address(c2));
        assertEq(approved[2], address(c3));

        // remove middle address
        whitelistMgr.removeFromWhitelist(address(c2));

        // verify c3 moved to c2's position
        approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 2);
        assertEq(approved[0], address(c1));
        assertEq(approved[1], address(c3));

        vm.stopPrank();
    }

    function test_SucceedsIfBatchRemovingMaintainsCorrectIndices() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);
        whitelistMgr.batchAddToWhitelist(addresses);

        // remove first and third addresses
        address[] memory toRemove = new address[](2);
        toRemove[0] = address(c1);
        toRemove[1] = address(c3);
        whitelistMgr.batchRemoveFromWhitelist(toRemove);

        // verify only c2 remains and is at index 0
        address[] memory remaining = whitelistMgr.getWhitelistedAddresses();
        assertEq(remaining.length, 1);
        assertEq(remaining[0], address(c2));

        assertFalse(whitelistMgr.isAddressWhitelisted(address(c1)));
        assertFalse(whitelistMgr.isAddressWhitelisted(address(c3)));

        vm.stopPrank();
    }
}

//
/// @notice Test for migrating the allow list configuration during diamond upgrades. Please remove this test after the next facet upgrade with the migration logic.
contract WhitelistManagerFacetMigrationTest is TestBase {
    using stdJson for string;

    // LiFi Diamond on mainnet with old DexManager and AllowList storage layout
    address internal constant DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

    WhitelistManagerFacet internal whitelistManagerWithMigrationLogic;
    IDexManagerFacet internal dexManager;
    MockSwapperFacet internal mockSwapperFacet;

    // Add this array of example selectors
    bytes4[] internal currentWhitelistedSelectors;

    function setUp() public {
        // Fork mainnet
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        vm.createSelectFork(rpcUrl, 22888619);

        // Replace JSON loading with hardcoded selectors
        currentWhitelistedSelectors = new bytes4[](5);
        currentWhitelistedSelectors[0] = 0x38ed1739; // swapExactTokensForTokens
        currentWhitelistedSelectors[1] = 0x8803dbee; // swapTokensForExactTokens
        currentWhitelistedSelectors[2] = 0x7c025200; // swap
        currentWhitelistedSelectors[3] = 0x7617b389; // exactInputSingle
        currentWhitelistedSelectors[4] = 0x90411a32; // execute

        // get DexManager interface
        dexManager = IDexManagerFacet(DIAMOND);
    }

    function test_MigrateAllowListWithSwapperCheck() public {
        mockSwapperFacet = new MockSwapperFacet();
        bytes4[] memory mockSwapperSelectors = new bytes4[](2);
        mockSwapperSelectors[0] = MockSwapperFacet.isContractAllowed.selector;
        mockSwapperSelectors[1] = MockSwapperFacet.isSelectorAllowed.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(mockSwapperFacet),
            mockSwapperSelectors
        );

        MockSwapperFacet mockSwapper = MockSwapperFacet(DIAMOND);

        // Using real whitelisted address from mainnet config
        address currentlyApprovedDex = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D; // Uniswap V2 Router
        // Using real whitelisted selector from config
        bytes4 approvedSelector = 0x38ed1739; // One of the whitelisted selectors

        // BEFORE: FACET WITH SWAPPERV2 LOGIC SHOULD BE ABLE TO DO A SWAP BEFORE MIGRATION
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should be allowed in allow list before migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should be allowed in allow list before migration"
        );

        // MIGRATION STARTS
        // get current whitelisted addresses (approvedDexs) from mainnet diamond using old DexManager interface
        address[] memory whitelistedAddresses = dexManager.approvedDexs();

        // get all selectors that should be whitelisted
        bytes4[] memory selectorsToWhitelist = getAllApprovedSelectors();

        // deploy facets
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // add WhitelistManagerFacet to diamond
        bytes4[]
            memory whitelistManagerWithMigrationLogicSelectors = new bytes4[](
                2
            );
        whitelistManagerWithMigrationLogicSelectors[0] = WhitelistManagerFacet
            .migrate
            .selector;
        whitelistManagerWithMigrationLogicSelectors[1] = WhitelistManagerFacet
            .isMigrated
            .selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(whitelistManagerWithMigrationLogic),
            whitelistManagerWithMigrationLogicSelectors
        );

        // add WhitelistManagerFacet to diamond in this test only to read the allow list and then to verify the whitelisted contract addresses and selectors
        WhitelistManagerFacet whitelistManagerFacet = new WhitelistManagerFacet();
        bytes4[] memory facetSelectors = new bytes4[](2);
        facetSelectors[0] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        facetSelectors[1] = WhitelistManagerFacet
            .getApprovedFunctionSelectors
            .selector;

        // add the facet to diamond
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(whitelistManagerFacet),
            facetSelectors
        );

        // now we can read through the diamond
        whitelistManagerWithMigrationLogic = WhitelistManagerFacet(DIAMOND);

        bool isMigrated = WhitelistManagerFacet(DIAMOND).isMigrated();
        assertTrue(
            !isMigrated,
            "WhitelistManagerFacet initially should not be migrated"
        );

        // initialize the allow list through the diamond
        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);

        // Call migrate() as the diamond owner to update the allow list configuration with whitelisted addresses and their
        // function selectors. This will:
        // 1. reset the old state to the initial state
        // 2. add the new contracts and selectors to the allow list one more time in order to have correct mapping of contract addresses and selectors
        WhitelistManagerFacet(DIAMOND).migrate(
            whitelistedAddresses,
            selectorsToWhitelist
        );

        isMigrated = WhitelistManagerFacet(DIAMOND).isMigrated();
        assertTrue(isMigrated, "WhitelistManagerFacet should be migrated");

        // verify final state
        address[] memory finalContracts = whitelistManagerWithMigrationLogic
            .getWhitelistedAddresses();
        bytes4[] memory finalSelectors = whitelistManagerWithMigrationLogic
            .getApprovedFunctionSelectors();

        // verify data matches
        assertEq(
            finalContracts.length,
            whitelistedAddresses.length,
            "whitelistedAddresses length mismatch"
        );
        assertEq(
            finalSelectors.length,
            selectorsToWhitelist.length,
            "whitelistedSelectors length mismatch"
        );

        // verify each selector matches
        for (uint256 i = 0; i < selectorsToWhitelist.length; i++) {
            assertEq(
                finalSelectors[i],
                selectorsToWhitelist[i],
                string(
                    abi.encodePacked(
                        "Selector mismatch at index ",
                        vm.toString(i)
                    )
                )
            );
        }
        // MIGRATION ENDS

        // AFTER: FACET WITH SWAPPERV2 LOGIC SHOULD BE ABLE TO DO A SWAP AFTER MIGRATION
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should still be allowed in allow list after migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should still be allowed in allow list after migration"
        );
    }

    function test_RevertWhenNotOwner() public {
        // deploy facets and set up the diamond like in the main test
        whitelistManagerWithMigrationLogic = new WhitelistManagerFacet();

        // add WhitelistManagerFacet to diamond
        bytes4[] memory migratorSelectors = new bytes4[](2);
        migratorSelectors[0] = WhitelistManagerFacet.migrate.selector;
        migratorSelectors[1] = WhitelistManagerFacet.isMigrated.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(whitelistManagerWithMigrationLogic),
            migratorSelectors
        );

        address[] memory newContracts = new address[](0);
        bytes4[] memory newSelectors = new bytes4[](0);

        // try to call migrate as non-owner
        address nonOwner = address(0x123);
        vm.prank(nonOwner);
        vm.expectRevert(UnAuthorized.selector);
        WhitelistManagerFacet(DIAMOND).migrate(newContracts, newSelectors);
    }

    function getAllApprovedSelectors()
        internal
        view
        returns (bytes4[] memory)
    {
        bytes4[] memory approvedSelectors = new bytes4[](5); // Changed from 165 to 5
        uint256 count = 0;

        // Replace JSON parsing with example selectors
        for (uint256 i = 0; i < currentWhitelistedSelectors.length; i++) {
            // check if this selector is approved
            if (
                dexManager.isFunctionApproved(currentWhitelistedSelectors[i])
            ) {
                approvedSelectors[count] = currentWhitelistedSelectors[i];
                count++;
            }
        }

        // create a new array with the exact size of the approved selectors
        bytes4[] memory result = new bytes4[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = approvedSelectors[i];
        }

        return result;
    }
}
