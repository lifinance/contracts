// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { CannotAuthoriseSelf, UnAuthorized } from "src/Errors/GenericErrors.sol";

contract Foo {}

contract DexManagerFacetTest is DSTest, DiamondTest {
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER = address(0x123456);
    address internal constant NOT_DIAMOND_OWNER = address(0xabc123456);

    LiFiDiamond internal diamond;
    DexManagerFacet internal dexMgr;
    Foo internal c1;
    Foo internal c2;
    Foo internal c3;

    function setUp() public {
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        dexMgr = new DexManagerFacet();
        c1 = new Foo();
        c2 = new Foo();
        c3 = new Foo();

        bytes4[] memory functionSelectors = new bytes4[](8);
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

        dexMgr = DexManagerFacet(address(diamond));
    }

    function test_CanAddDEX() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(c1));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], address(c1));

        vm.stopPrank();
    }

    function test_CanRemoveDEX() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(c1));
        dexMgr.removeDex(address(c1));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 0);

        vm.stopPrank();
    }

    function test_CanBatchAddDEXs() public {
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

    function test_CanBatchRemoveDEXs() public {
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

    function test_CanApproveFunctionSignature() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";
        dexMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(dexMgr.isFunctionApproved(signature));

        vm.stopPrank();
    }

    function test_CanApproveBatchFunctionSignature() public {
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

    function testFail_AddZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(0));

        vm.stopPrank();
    }

    function testFail_AddNonContract() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(1337));

        vm.stopPrank();
    }

    function testFail_BatchAddZeroAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(0);
        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testFail_BatchAddNonContract() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(1337);
        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailToAddDexFromNotOwner() public {
        vm.startPrank(NOT_DIAMOND_OWNER); // prank a non-owner to attempt adding a DEX

        vm.expectRevert(UnAuthorized.selector);

        dexMgr.addDex(address(c1));

        vm.stopPrank();
    }

    function testRevert_FailToBatchAddDexFromNotOwner() public {
        vm.startPrank(NOT_DIAMOND_OWNER);
        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(c2);

        vm.expectRevert(UnAuthorized.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailToAddDexWhereDexIsDexManager() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(dexMgr); // contract itself

        vm.expectRevert(CannotAuthoriseSelf.selector);

        dexMgr.batchAddDex(dexs);

        vm.stopPrank();
    }

    function testRevert_FailToRemoveDexFromNotOwner() public {
        vm.prank(USER_DIAMOND_OWNER);

        dexMgr.addDex(address(c1));

        vm.stopPrank();

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.removeDex(address(c1));
    }

    function testRevert_FailToBatchRemoveDexFromNotOwner() public {
        address[] memory dexs = new address[](2);
        dexs[0] = address(c1);
        dexs[1] = address(c2);

        vm.prank(USER_DIAMOND_OWNER);
        dexMgr.batchAddDex(dexs);

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.batchRemoveDex(dexs);
    }

    function testRevert_FailToSetFunctionApprovalBySignatureFromNotOwner()
        public
    {
        bytes4 signature = hex"faceface";

        vm.expectRevert(UnAuthorized.selector);

        vm.prank(NOT_DIAMOND_OWNER);
        dexMgr.setFunctionApprovalBySignature(signature, true);
    }

    function testRevert_FailToBatchSetFunctionApprovalBySignatureFromNotOwner()
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

    function testRevert_CanSetFunctionApprovalBySignatureFromOwner() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        bytes4 signature = hex"faceface";

        dexMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(dexMgr.isFunctionApproved(signature));

        dexMgr.setFunctionApprovalBySignature(signature, false);
        assertFalse(dexMgr.isFunctionApproved(signature));

        vm.stopPrank();
    }

    function testRevert_CanSetBatchFunctionApprovalBySignatureFromOwner()
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
}
