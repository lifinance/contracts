// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract Foo {}

contract DexManagerFacetTest is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    DexManagerFacet internal dexMgr;
    Foo internal c1;
    Foo internal c2;
    Foo internal c3;

    function setUp() public {
        diamond = createDiamond();
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

    function testCanAddDEX() public {
        dexMgr.addDex(address(c1));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], address(c1));
    }

    function testCanRemoveDEX() public {
        dexMgr.addDex(address(c1));
        dexMgr.removeDex(address(c1));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 0);
    }

    function testCanBatchAddDEXs() public {
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
    }

    function testCanBatchRemoveDEXs() public {
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
    }

    function testCanApproveFunctionSignature() public {
        bytes4 signature = hex"faceface";
        dexMgr.setFunctionApprovalBySignature(signature, true);
        assertTrue(dexMgr.isFunctionApproved(signature));
    }

    function testCanApproveBatchFunctionSignature() public {
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
    }

    function testFailAddZeroAddress() public {
        dexMgr.addDex(address(0));
    }

    function testFailAddNonContract() public {
        dexMgr.addDex(address(1337));
    }

    function testFailBatchAddZeroAddress() public {
        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(0);
        dexMgr.batchAddDex(dexs);
    }

    function testFailBatchAddNonContract() public {
        address[] memory dexs = new address[](3);
        dexs[0] = address(c1);
        dexs[1] = address(c2);
        dexs[2] = address(1337);
        dexMgr.batchAddDex(dexs);
    }
}
