// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.7;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DexManagerFacetTest is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    DexManagerFacet internal dexMgr;

    function setUp() public {
        diamond = createDiamond();
        dexMgr = new DexManagerFacet();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = DexManagerFacet.addDex.selector;
        functionSelectors[1] = DexManagerFacet.removeDex.selector;
        functionSelectors[2] = DexManagerFacet.batchAddDex.selector;
        functionSelectors[3] = DexManagerFacet.batchRemoveDex.selector;
        functionSelectors[4] = DexManagerFacet.approvedDexs.selector;

        addFacet(diamond, address(dexMgr), functionSelectors);

        dexMgr = DexManagerFacet(address(diamond));
    }

    function testCanAddDEX() public {
        dexMgr.addDex(address(1337));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], address(1337));
    }

    function testCanRemoveDEX() public {
        dexMgr.addDex(address(1337));
        dexMgr.removeDex(address(1337));
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 0);
    }

    function testCanBatchAddDEXs() public {
        address[] memory dexs = new address[](3);
        dexs[0] = address(1337);
        dexs[1] = address(420);
        dexs[2] = address(69);
        dexMgr.batchAddDex(dexs);
        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved[0], dexs[0]);
        assertEq(approved[1], dexs[1]);
        assertEq(approved[2], dexs[2]);
    }

    function testCanBatchRemoveDEXs() public {
        address[] memory dexs = new address[](3);
        dexs[0] = address(1337);
        dexs[1] = address(420);
        dexs[2] = address(69);
        dexMgr.batchAddDex(dexs);

        address[] memory remove = new address[](2);
        remove[0] = address(1337);
        remove[1] = address(420);
        dexMgr.batchRemoveDex(remove);

        address[] memory approved = dexMgr.approvedDexs();
        assertEq(approved.length, 1);
        assertEq(approved[0], dexs[2]);
    }

    function testFailAddZeroAddress() public {
        dexMgr.addDex(address(0));
    }

    function testFailBatchAddZeroAddress() public {
        address[] memory dexs = new address[](3);
        dexs[0] = address(1337);
        dexs[1] = address(420);
        dexs[2] = address(0);
        dexMgr.batchAddDex(dexs);
    }
}
