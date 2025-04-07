// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { InvalidContract, CannotAuthoriseSelf, UnAuthorized } from "lifi/Errors/GenericErrors.sol";

contract Foo {}

contract DexManagerFacetTest is DSTest, DiamondTest {
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER = address(0x123456);
    address internal constant NOT_DIAMOND_OWNER = address(0xabc123456);

    LiFiDiamond internal diamond;
    DexManagerFacet internal dexMgr;
    AccessManagerFacet internal accessMgr;
    Foo internal c1;
    Foo internal c2;
    Foo internal c3;

    event DexAdded(address indexed dexAddress);
    event DexRemoved(address indexed dexAddress);
    event FunctionSignatureApprovalChanged(
        bytes4 indexed functionSignature,
        bool indexed approved
    );

    function setUp() public {
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        dexMgr = new DexManagerFacet();
        c1 = new Foo();
        c2 = new Foo();
        c3 = new Foo();

        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = DexManagerFacet.addDex.selector;
        functionSelectors[1] = DexManagerFacet.removeDex.selector;
        functionSelectors[2] = DexManagerFacet.batchAddDex.selector;
        functionSelectors[3] = DexManagerFacet.batchRemoveDex.selector;
        functionSelectors[4] = DexManagerFacet.approvedDexs.selector;
        functionSelectors[5] = DexManagerFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[6] = DexManagerFacet
            .batchSetFunctionApprovalBySignature
            .selector;
        functionSelectors[7] = DexManagerFacet.isFunctionApproved.selector;

        addFacet(diamond, address(dexMgr), functionSelectors);

        // add AccessManagerFacet to be able to whitelist addresses for execution of protected functions
        accessMgr = new AccessManagerFacet();

        functionSelectors = new bytes4[](2);
        functionSelectors[0] = accessMgr.setCanExecute.selector;
        functionSelectors[1] = accessMgr.addressCanExecuteMethod.selector;
        addFacet(diamond, address(accessMgr), functionSelectors);

        accessMgr = AccessManagerFacet(address(diamond));
        dexMgr = DexManagerFacet(address(diamond));
    }

    function test_SucceedsIfOwnerAddsDex() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(c1));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], address(c1));

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerRemovesDex() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true);
        emit DexAdded(address(c1));

        dexMgr.addDex(address(c1));

        vm.expectEmit(true, true, true, true);
        emit DexRemoved(address(c1));

        dexMgr.removeDex(address(c1));

        vm.stopPrank();

        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 0);
    }

    function test_SucceedsIfOwnerBatchAddsDexes() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(c3);
        dexMgr.batchAddDex(dexs);
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], dexs[0]);
        assertEq(approved[1], dexs[1]);
        assertEq(approved[2], dexs[2]);
        assertEq(approved.length, 3);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerBatchRemovesDexes() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(c3);
        dexMgr.batchAddDex(dexs);

        address[] memory remove = new address[](2);
        remove[0] = address(c1);
        remove[1] = address(c2);
        dexMgr.batchRemoveDex(remove);

        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 1);
        assertEq(approved[0], dexs[2]);

        vm.stopPrank();
    }

    function test_SucceedsIfOwnerApprovesFunctionSignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";

        vm.expectEmit(true, true, true, true);
        emit FunctionSignatureApprovalChanged(signature, true);
        dexMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(dexMgr.isFunctionApproved(signature));

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
        dexMgr.batchSetFunctionApprovalBySignature(signatures, true);
        for (uint256 i = 0; i < 5; ) {
            assertTrue(dexMgr.isFunctionApproved(signatures[i]));
            unchecked {
                ++i;
            }
        }

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingDexWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidContract.selector);

        dexMgr.addDex(address(0));

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingDexThatIsNotAContract() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidContract.selector);

        dexMgr.addDex(address(1337));

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchAddingDexsWithZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(0);

        vm.expectRevert(InvalidContract.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailsIfBatchAddingDexsThatAreNotAContracts() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(1337);

        vm.expectRevert(InvalidContract.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToAddDex() public {
        vm.startPrank(NOT_DIAMOND_OWNER); // prank a non-owner to attempt adding a DEX

        vm.expectRevert(UnAuthorized.selector);

        dexMgr.addDex(address(c1));

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToBatchAddDex() public {
        vm.startPrank(NOT_DIAMOND_OWNER);
        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(c2);

        vm.expectRevert(UnAuthorized.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailsIfAddingDexThatIsDexManager() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(dexMgr); // contract itself

        vm.expectRevert(CannotAuthoriseSelf.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailsIfNonOwnerTriesToRemoveDex() public {
        vm.prank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(c1));

        vm.stopPrank();

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.removeDex(address(c1));
    }

    function testRevert_FailsIfNonOwnerTriesToBatchRemoveDex() public {
        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(c2);

        vm.prank(USER_DIAMOND_OWNER);
        dexMgr.batchAddDex(dexs);

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.batchRemoveDex(dexs);
    }

    function testRevert_FailsIfNonOwnerTriesToSetFunctionApprovalBySignature()
        public
    {
        bytes4 signature = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.setFunctionApprovalBySignature(signature, true);
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
        dexMgr.batchSetFunctionApprovalBySignature(signatures, true);
    }

    function test_SucceedsIfOwnerSetsFunctionApprovalBySignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";

        dexMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(dexMgr.isFunctionApproved(signature));

        dexMgr.setFunctionApprovalBySignature(signature, false);
        assertFalse(dexMgr.isFunctionApproved(signature));

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

        dexMgr.batchSetFunctionApprovalBySignature(signatures, true);
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(dexMgr.isFunctionApproved(signatures[i]));
        }

        dexMgr.batchSetFunctionApprovalBySignature(signatures, false);
        for (uint256 i = 0; i < 3; i++) {
            assertFalse(dexMgr.isFunctionApproved(signatures[i]));
        }

        vm.stopPrank();
    }

    function test_AllowsWhitelistedAddressToAddContract() public {
        vm.stopPrank();
        vm.startPrank(USER_PAUSER);
        vm.expectRevert(UnAuthorized.selector);

        dexMgr.addDex(address(c1));

        // allow USER_PAUSER address to execute addDex() function
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            DexManagerFacet.addDex.selector,
            USER_PAUSER,
            true
        );

        // try to call addDex()
        vm.startPrank(USER_PAUSER);

        dexMgr.addDex(address(c1));

        address[] memory approved = dexMgr.approvedDexs();

        assertEq(approved[0], address(c1));
    }

    function test_AllowsWhitelistedAddressToBatchAddContract() public {
        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(c2);

        vm.stopPrank();
        vm.startPrank(USER_PAUSER);

        vm.expectRevert(UnAuthorized.selector);

        dexMgr.batchAddDex(dexs);

        // allow USER_PAUSER address to execute batchAddDex() function
        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            DexManagerFacet.batchAddDex.selector,
            USER_PAUSER,
            true
        );

        // try to call addDex()
        vm.startPrank(USER_PAUSER);

        dexMgr.batchAddDex(dexs);

        address[] memory approved = dexMgr.approvedDexs();

        assertEq(approved[0], address(c1));
        assertEq(approved[1], address(c2));
    }

    function test_BatchAddKeepsAlreadyApprovedDexAndAddsNewOnes() public {
        address[] memory dexs = new address[](1);
        dexs[0] = address(c2);

        vm.startPrank(USER_DIAMOND_OWNER);

        accessMgr.setCanExecute(
            DexManagerFacet.batchAddDex.selector,
            USER_PAUSER,
            true
        );

        // try to call addDex()
        vm.startPrank(USER_PAUSER);

        dexMgr.batchAddDex(dexs);

        address[] memory approved = dexMgr.approvedDexs();

        assertEq(approved[0], address(c2));

        dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2); // already whitelisted
        dexs[2] = address(c3);

        dexMgr.batchAddDex(dexs);

        approved = dexMgr.approvedDexs();

        assertEq(approved[0], address(c2));
        assertEq(approved[1], address(c1));
        assertEq(approved[2], address(c3));
    }
}
