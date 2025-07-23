// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { OwnershipFacet } from "src/Facets/OwnershipFacet.sol";
import { InvalidContract, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";
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
    event FunctionSelectorWhitelistChanged(
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
            .setFunctionWhitelistBySelector
            .selector;
        functionSelectors[6] = WhitelistManagerFacet
            .batchSetFunctionWhitelistBySelector
            .selector;
        functionSelectors[7] = WhitelistManagerFacet
            .isFunctionSelectorWhitelisted
            .selector;
        functionSelectors[8] = WhitelistManagerFacet
            .isAddressWhitelisted
            .selector;
        functionSelectors[9] = WhitelistManagerFacet
            .getWhitelistedFunctionSelectors
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
        emit FunctionSelectorWhitelistChanged(selector, true);

        whitelistMgr.setFunctionWhitelistBySelector(selector, true);
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
        whitelistMgr.batchSetFunctionWhitelistBySelector(selectors, true);
        for (uint256 i = 0; i < 5; ) {
            assertTrue(
                whitelistMgr.isFunctionSelectorWhitelisted(selectors[i])
            );
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

    function testRevert_FailsIfNonOwnerTriesTosetFunctionWhitelistBySelector()
        public
    {
        bytes4 selector = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.setFunctionWhitelistBySelector(selector, true);
    }

    function testRevert_FailsIfNonOwnerTriesTobatchSetFunctionWhitelistBySelector()
        public
    {
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchSetFunctionWhitelistBySelector(selectors, true);
    }

    function test_SucceedsIfOwnerSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";

        whitelistMgr.setFunctionWhitelistBySelector(selector, true);
        assertTrue(whitelistMgr.isFunctionSelectorWhitelisted(selector));

        whitelistMgr.setFunctionWhitelistBySelector(selector, false);
        assertFalse(whitelistMgr.isFunctionSelectorWhitelisted(selector));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchSetsFunctionApprovalBySelector() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = bytes4(hex"faceface");
        selectors[1] = bytes4(hex"deadbeef");
        selectors[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionWhitelistBySelector(selectors, true);
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(
                whitelistMgr.isFunctionSelectorWhitelisted(selectors[i])
            );
        }

        whitelistMgr.batchSetFunctionWhitelistBySelector(selectors, false);
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(
                whitelistMgr.isFunctionSelectorWhitelisted(selectors[i])
            );
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
            .getWhitelistedFunctionSelectors();
        assertEq(selectors.length, 0);

        vm.stopPrank();
    }

    function test_SucceedsIfSingleApprovedSelectorIsReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 selector = hex"faceface";
        whitelistMgr.setFunctionWhitelistBySelector(selector, true);

        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
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

        whitelistMgr.batchSetFunctionWhitelistBySelector(testSelectors, true);

        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
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

        whitelistMgr.batchSetFunctionWhitelistBySelector(testSelectors, true);

        // Remove the middle selector
        whitelistMgr.setFunctionWhitelistBySelector(testSelectors[1], false);

        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
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

        whitelistMgr.batchSetFunctionWhitelistBySelector(testSelectors, true);

        bytes4[] memory removeSelectors = new bytes4[](3);
        removeSelectors[0] = testSelectors[1]; // deadbeef
        removeSelectors[1] = testSelectors[3]; // beefdead
        removeSelectors[2] = testSelectors[4]; // facedead

        whitelistMgr.batchSetFunctionWhitelistBySelector(
            removeSelectors,
            false
        );

        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
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
        whitelistMgr.setFunctionWhitelistBySelector(selector1, true);

        // Try to remove a different selector that was never approved
        bytes4 selector2 = bytes4(hex"deadbeef");
        whitelistMgr.setFunctionWhitelistBySelector(selector2, false);

        // Verify the state is correct
        bytes4[] memory selectors = whitelistMgr
            .getWhitelistedFunctionSelectors();
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

        whitelistMgr.setFunctionWhitelistBySelector(selector1, true);
        assertTrue(whitelistMgr.isFunctionSelectorWhitelisted(selector1));

        whitelistMgr.setFunctionWhitelistBySelector(selector2, true);
        assertTrue(whitelistMgr.isFunctionSelectorWhitelisted(selector2));

        whitelistMgr.setFunctionWhitelistBySelector(selector3, true);
        assertTrue(whitelistMgr.isFunctionSelectorWhitelisted(selector3));

        // get all selectors to verify order
        bytes4[] memory approved = whitelistMgr
            .getWhitelistedFunctionSelectors();
        assertEq(approved.length, 3);
        assertEq(approved[0], selector1);
        assertEq(approved[1], selector2);
        assertEq(approved[2], selector3);

        // remove first selector
        whitelistMgr.setFunctionWhitelistBySelector(selector2, false);

        // verify selector3 was moved to index 1
        approved = whitelistMgr.getWhitelistedFunctionSelectors();
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
        // Use a dummy private key for testing (32 bytes)
        vm.setEnv(
            "PRIVATE_KEY",
            "0x1234567890123456789012345678901234567890123456789012345678901234"
        );

        // Create instance of deployment script to access getCallData
        deployScript = new ExposedUpdateWhitelistManagerFacetDeployScript();
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
        mockSwapperFacet = new MockSwapperFacet();
        bytes4[] memory mockSwapperSelectors = new bytes4[](2);
        mockSwapperSelectors[0] = MockSwapperFacet.isContractAllowed.selector;
        mockSwapperSelectors[1] = MockSwapperFacet.isSelectorAllowed.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(mockSwapperFacet),
            mockSwapperSelectors
        );

        // Get current state from legacy DexManagerFacet
        (, bytes memory data) = DIAMOND.staticcall(
            abi.encodeWithSignature("approvedDexs()")
        );
        address[] memory currentWhitelistedAddresses = abi.decode(
            data,
            (address[])
        );

        // Test with real production data from mainnet
        address currentlyApprovedDex = currentWhitelistedAddresses[0]; // Use first whitelisted DEX
        bytes4 approvedSelector = 0x38ed1739; // One of the whitelisted selectors

        // Verify pre-migration state with mock swapper
        MockSwapperFacet mockSwapper = MockSwapperFacet(DIAMOND);
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should be allowed before migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should be allowed before migration"
        );

        // Read config data and verify it's loaded correctly
        (
            address[] memory contractsToAdd,
            bytes4[] memory selectorsToAdd
        ) = _loadAndVerifyConfigData();

        // Prepare and execute diamond cut
        LibDiamond.FacetCut[] memory cuts = _prepareDiamondCut();
        bytes memory initCallData = deployScript.exposed_getCallData();
        _executeDiamondCut(cuts, initCallData);

        // Verify final state
        _verifyFinalState(
            contractsToAdd,
            selectorsToAdd,
            mockSwapper,
            currentlyApprovedDex,
            approvedSelector
        );
    }

    function _loadAndVerifyConfigData()
        internal
        returns (
            address[] memory contractsToAdd,
            bytes4[] memory selectorsToAdd
        )
    {
        // Read addresses to add for the current network
        string memory addressesPath = string.concat(
            vm.projectRoot(),
            "/config/whitelistedAddresses.json"
        );
        string memory addressesJson = vm.readFile(addressesPath);
        string[] memory rawAddresses = vm.parseJsonStringArray(
            addressesJson,
            string.concat(".", "base") // <== base network
        );
        contractsToAdd = new address[](rawAddresses.length);
        for (uint256 i = 0; i < rawAddresses.length; i++) {
            contractsToAdd[i] = vm.parseAddress(rawAddresses[i]);
        }

        // Read selectors to add
        string memory selectorsToAddPath = string.concat(
            vm.projectRoot(),
            "/config/whitelistedSelectors.json"
        );
        string memory selectorsToAddJson = vm.readFile(selectorsToAddPath);
        string[] memory rawSelectorsToAdd = vm.parseJsonStringArray(
            selectorsToAddJson,
            ".selectors"
        );
        selectorsToAdd = new bytes4[](rawSelectorsToAdd.length);
        for (uint256 i = 0; i < rawSelectorsToAdd.length; i++) {
            selectorsToAdd[i] = bytes4(vm.parseBytes(rawSelectorsToAdd[i]));
        }
    }

    function _setupMockSwapper(
        address approvedDex
    ) internal returns (MockSwapperFacet) {
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

        // Verify pre-migration state
        bytes4 approvedSelector = 0x38ed1739;
        assertTrue(
            mockSwapper.isContractAllowed(approvedDex),
            "Contract should be allowed before migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should be allowed before migration"
        );

        return mockSwapper;
    }

    function _prepareDiamondCut()
        internal
        view
        returns (LibDiamond.FacetCut[] memory cuts)
    {
        // Build selectors array excluding migrate()
        bytes4[] memory allSelectors = new bytes4[](11);
        allSelectors[0] = WhitelistManagerFacet.addToWhitelist.selector;
        allSelectors[1] = WhitelistManagerFacet.removeFromWhitelist.selector;
        allSelectors[2] = WhitelistManagerFacet.batchAddToWhitelist.selector;
        allSelectors[3] = WhitelistManagerFacet
            .batchRemoveFromWhitelist
            .selector;
        allSelectors[4] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        allSelectors[5] = WhitelistManagerFacet
            .setFunctionWhitelistBySelector
            .selector;
        allSelectors[6] = WhitelistManagerFacet
            .batchSetFunctionWhitelistBySelector
            .selector;
        allSelectors[7] = WhitelistManagerFacet
            .isFunctionSelectorWhitelisted
            .selector;
        allSelectors[8] = WhitelistManagerFacet.isAddressWhitelisted.selector;
        allSelectors[9] = WhitelistManagerFacet
            .getWhitelistedFunctionSelectors
            .selector;
        allSelectors[10] = WhitelistManagerFacet.isMigrated.selector;

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
        address[] memory expectedAddresses,
        bytes4[] memory expectedSelectors,
        MockSwapperFacet mockSwapper,
        address currentlyApprovedDex,
        bytes4 approvedSelector
    ) internal {
        // Get final state
        address[] memory finalContracts = WhitelistManagerFacet(DIAMOND)
            .getWhitelistedAddresses();
        bytes4[] memory finalSelectors = WhitelistManagerFacet(DIAMOND)
            .getWhitelistedFunctionSelectors();

        // Verify lengths match
        assertEq(
            finalContracts.length,
            expectedAddresses.length,
            "Whitelisted addresses length mismatch"
        );
        assertEq(
            finalSelectors.length,
            expectedSelectors.length,
            "Whitelisted selectors length mismatch"
        );

        // Verify each address is correctly migrated
        for (uint256 i = 0; i < expectedAddresses.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < finalContracts.length; j++) {
                if (finalContracts[j] == expectedAddresses[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "Address not found in final contracts");
        }

        // Verify each selector is correctly migrated
        for (uint256 i = 0; i < expectedSelectors.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < finalSelectors.length; j++) {
                if (finalSelectors[j] == expectedSelectors[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "Selector not found in final selectors");
        }

        // Verify existing integrations still work after migration
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should still be allowed after migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should still be allowed after migration"
        );
    }
}

contract ExposedUpdateWhitelistManagerFacetDeployScript is DeployScript {
    function exposed_getCallData() public returns (bytes memory) {
        return getCallData();
    }
}
