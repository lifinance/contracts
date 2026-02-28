// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../utils/DiamondTest.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { OnlyContractOwner } from "src/Errors/GenericErrors.sol";

contract PeripheryRegistryFacetTest is DiamondTest {
    LiFiDiamond internal diamond;
    PeripheryRegistryFacet internal registry;

    address internal constant OWNER = address(0x1111);
    address internal constant PAUSER = address(0x2222);
    address internal constant NOT_OWNER = address(0x3333);

    event PeripheryContractRegistered(string name, address contractAddress);

    function setUp() public {
        diamond = createDiamond(OWNER, PAUSER);
        registry = PeripheryRegistryFacet(address(diamond));

        vm.label(address(diamond), "LiFiDiamond");
        vm.label(OWNER, "OWNER");
        vm.label(PAUSER, "PAUSER");
        vm.label(NOT_OWNER, "NOT_OWNER");
    }

    function testRevert_registerPeripheryContract_NotContractOwner() public {
        vm.startPrank(NOT_OWNER);

        vm.expectRevert(OnlyContractOwner.selector);

        registry.registerPeripheryContract("FeeCollector", address(0xBEEF));

        vm.stopPrank();
    }

    function test_registerPeripheryContract_StoresAndEmits() public {
        string memory name = "FeeCollector";
        address contractAddress = address(0xBEEF);

        vm.startPrank(OWNER);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit PeripheryContractRegistered(name, contractAddress);
        registry.registerPeripheryContract(name, contractAddress);

        vm.stopPrank();

        assertEq(registry.getPeripheryContract(name), contractAddress);
    }
}
