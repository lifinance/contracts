// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { InvalidContract, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract Foo {}

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
    event FunctionSignatureApprovalChanged(
        bytes4 indexed functionSignature,
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
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[6] = WhitelistManagerFacet
            .batchSetFunctionApprovalBySignature
            .selector;
        functionSelectors[7] = WhitelistManagerFacet
            .isFunctionApproved
            .selector;
        functionSelectors[8] = WhitelistManagerFacet
            .isAddressWhitelisted
            .selector;
        functionSelectors[9] = WhitelistManagerFacet
            .getApprovedFunctionSignatures
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

        whitelistMgr.addToWhitelist(address(c1));
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved[0], address(c1));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerRemovesAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true);
        emit AddressWhitelisted(address(c1));

        whitelistMgr.addToWhitelist(address(c1));

        vm.expectEmit(true, true, true, true);
        emit AddressRemoved(address(c1));

        whitelistMgr.removeFromWhitelist(address(c1));

        vm.stopPrank();

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 0);
    }

    function test_SucceedsIfOwnerBatchAddsAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);
        whitelistMgr.batchAddToWhitelist(addresses);
        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved[0], addresses[0]);
        assertEq(approved[1], addresses[1]);
        assertEq(approved[2], addresses[2]);
        assertEq(approved.length, 3);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchRemovesAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory addresses = new address[](3);
        addresses[0] = address(c1);
        addresses[1] = address(c2);
        addresses[2] = address(c3);
        whitelistMgr.batchAddToWhitelist(addresses);

        address[] memory remove = new address[](2);
        remove[0] = address(c1);
        remove[1] = address(c2);
        whitelistMgr.batchRemoveFromWhitelist(remove);

        address[] memory approved = whitelistMgr.getWhitelistedAddresses();
        assertEq(approved.length, 1);
        assertEq(approved[0], addresses[2]);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerApprovesFunctionSignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";

        vm.expectEmit(true, true, true, true);
        emit FunctionSignatureApprovalChanged(signature, true);
        whitelistMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(whitelistMgr.isFunctionApproved(signature));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchApprovesFunctionSignatures() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory signatures = new bytes4[](5);
        signatures[0] = bytes4(hex"faceface");
        signatures[1] = bytes4(hex"deadbeef");
        signatures[2] = bytes4(hex"deaddead");
        signatures[3] = bytes4(hex"deadface");
        signatures[4] = bytes4(hex"beefbeef");
        whitelistMgr.batchSetFunctionApprovalBySignature(signatures, true);
        for (uint256 i = 0; i < 5; ) {
            assertTrue(whitelistMgr.isFunctionApproved(signatures[i]));
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

    function testRevert_FailsIfNonOwnerTriesToSetFunctionApprovalBySignature()
        public
    {
        bytes4 signature = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.setFunctionApprovalBySignature(signature, true);
    }

    function testRevert_FailsIfNonOwnerTriesToBatchSetFunctionApprovalBySignature()
        public
    {
        bytes4[] memory signatures = new bytes4[](3);
        signatures[0] = bytes4(hex"faceface");
        signatures[1] = bytes4(hex"deadbeef");
        signatures[2] = bytes4(hex"beefbeef");

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        whitelistMgr.batchSetFunctionApprovalBySignature(signatures, true);
    }

    function test_SucceedsIfOwnerSetsFunctionApprovalBySignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";

        whitelistMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(whitelistMgr.isFunctionApproved(signature));

        whitelistMgr.setFunctionApprovalBySignature(signature, false);
        assertFalse(whitelistMgr.isFunctionApproved(signature));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchSetsFunctionApprovalBySignature()
        public
    {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory signatures = new bytes4[](3);
        signatures[0] = bytes4(hex"faceface");
        signatures[1] = bytes4(hex"deadbeef");
        signatures[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySignature(signatures, true);
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(whitelistMgr.isFunctionApproved(signatures[i]));
        }

        whitelistMgr.batchSetFunctionApprovalBySignature(signatures, false);
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(whitelistMgr.isFunctionApproved(signatures[i]));
        }

        vm.stopPrank();
    }

    function test_AllowsWhitelistedAddressToAddContract() public {
        vm.stopPrank();
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

    function test_SucceedsIfNoApprovedSignaturesReturnsEmptyArray() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 0);

        vm.stopPrank();
    }

    function test_SucceedsIfSingleApprovedSignatureIsReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";
        whitelistMgr.setFunctionApprovalBySignature(signature, true);

        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 1);
        assertEq(signatures[0], signature);

        vm.stopPrank();
    }

    function test_SucceedsIfMultipleApprovedSignaturesAreReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSignatures = new bytes4[](3);
        testSignatures[0] = bytes4(hex"faceface");
        testSignatures[1] = bytes4(hex"deadbeef");
        testSignatures[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySignature(testSignatures, true);

        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 3);

        bool foundSig0 = false;
        bool foundSig1 = false;
        bool foundSig2 = false;

        for (uint256 i = 0; i < signatures.length; i++) {
            if (signatures[i] == testSignatures[0]) foundSig0 = true;
            if (signatures[i] == testSignatures[1]) foundSig1 = true;
            if (signatures[i] == testSignatures[2]) foundSig2 = true;
        }

        assertTrue(foundSig0);
        assertTrue(foundSig1);
        assertTrue(foundSig2);

        vm.stopPrank();
    }

    function test_SucceedsIfRemovedSignaturesAreNotReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSignatures = new bytes4[](3);
        testSignatures[0] = bytes4(hex"faceface");
        testSignatures[1] = bytes4(hex"deadbeef");
        testSignatures[2] = bytes4(hex"beefbeef");

        whitelistMgr.batchSetFunctionApprovalBySignature(testSignatures, true);

        // Remove the middle signature
        whitelistMgr.setFunctionApprovalBySignature(testSignatures[1], false);

        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 2);

        bool foundSig0 = false;
        bool foundSig1 = false;
        bool foundSig2 = false;

        for (uint256 i = 0; i < signatures.length; i++) {
            if (signatures[i] == testSignatures[0]) foundSig0 = true;
            if (signatures[i] == testSignatures[1]) foundSig1 = true;
            if (signatures[i] == testSignatures[2]) foundSig2 = true;
        }

        assertTrue(foundSig0);
        assertFalse(foundSig1); // This should not be found
        assertTrue(foundSig2);

        vm.stopPrank();
    }

    function test_SucceedsIfBatchRemovedSignaturesAreNotReturned() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4[] memory testSignatures = new bytes4[](5);
        testSignatures[0] = bytes4(hex"faceface");
        testSignatures[1] = bytes4(hex"deadbeef");
        testSignatures[2] = bytes4(hex"beefbeef");
        testSignatures[3] = bytes4(hex"beefdead");
        testSignatures[4] = bytes4(hex"facedead");

        whitelistMgr.batchSetFunctionApprovalBySignature(testSignatures, true);

        bytes4[] memory removeSignatures = new bytes4[](3);
        removeSignatures[0] = testSignatures[1]; // deadbeef
        removeSignatures[1] = testSignatures[3]; // beefdead
        removeSignatures[2] = testSignatures[4]; // facedead

        whitelistMgr.batchSetFunctionApprovalBySignature(
            removeSignatures,
            false
        );

        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 2);

        // Expected remaining: faceface (0) and beefbeef (2)
        bool foundSig0 = false;
        bool foundSig2 = false;

        for (uint256 i = 0; i < signatures.length; i++) {
            if (signatures[i] == testSignatures[0]) foundSig0 = true;
            if (signatures[i] == testSignatures[2]) foundSig2 = true;
        }

        assertTrue(foundSig0);
        assertTrue(foundSig2);

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

    function test_SucceedsIfRemovingNonApprovedSignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // Add one signature
        bytes4 signature1 = bytes4(hex"faceface");
        whitelistMgr.setFunctionApprovalBySignature(signature1, true);

        // Try to remove a different signature that was never approved
        bytes4 signature2 = bytes4(hex"deadbeef");
        whitelistMgr.setFunctionApprovalBySignature(signature2, false);

        // Verify the state is correct
        bytes4[] memory signatures = whitelistMgr
            .getApprovedFunctionSignatures();
        assertEq(signatures.length, 1);
        assertEq(signatures[0], signature1);

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

    function test_SucceedsIfLegacyApprovedSelectorIsMigratedToArray() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        // choose a selector to test with
        bytes4 selector = bytes4(hex"cafe0001");

        bytes32 s = keccak256("com.lifi.library.allow.list");
        // selectorAllowList mapping lives at slot s+1
        bytes32 mappingSlot = bytes32(uint256(s) + 1);

        // now the actual storage slot for your key is
        bytes32 actualSlot = keccak256(
            abi.encodePacked(
                bytes32(selector), // left-pad your bytes4 to 32 bytes
                mappingSlot
            )
        );

        vm.store(address(diamond), actualSlot, bytes32(uint256(1)));

        // verify our manipulation worked. the selector should be approved in the mapping
        assertTrue(whitelistMgr.isFunctionApproved(selector));

        // should not appear in the array yet
        bytes4[] memory initialSignatures = whitelistMgr
            .getApprovedFunctionSignatures();
        bool foundInArray = false;
        for (uint256 i = 0; i < initialSignatures.length; i++) {
            if (initialSignatures[i] == selector) {
                foundInArray = true;
                break;
            }
        }
        assertFalse(foundInArray, "Selector should not be in array yet");

        // now call addAllowedSelector again via a function call that uses it
        // this should trigger the legacy migration code
        whitelistMgr.setFunctionApprovalBySignature(selector, true);

        // now the selector should be in the array
        bytes4[] memory finalSignatures = whitelistMgr
            .getApprovedFunctionSignatures();
        foundInArray = false;
        for (uint256 i = 0; i < finalSignatures.length; i++) {
            if (finalSignatures[i] == selector) {
                foundInArray = true;
                break;
            }
        }
        assertTrue(foundInArray, "Selector should now be in array");

        // and the array length should have increased by 1
        assertEq(finalSignatures.length, initialSignatures.length + 1);

        vm.stopPrank();
    }
}
