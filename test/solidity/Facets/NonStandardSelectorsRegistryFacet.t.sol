// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../utils/TestBase.sol";
import "lifi/Facets/NonStandardSelectorsRegistryFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { OnlyContractOwner } from "lifi/Errors/GenericErrors.sol";

contract NonStandardSelectorRegistryFacetTest is TestBase {
    NonStandardSelectorsRegistryFacet internal registry;

    function setUp() public {
        initTestBase();
        registry = new NonStandardSelectorsRegistryFacet();

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = NonStandardSelectorsRegistryFacet
            .setNonStandardSelector
            .selector;
        functionSelectors[1] = NonStandardSelectorsRegistryFacet
            .isNonStandardSelector
            .selector;
        functionSelectors[2] = NonStandardSelectorsRegistryFacet
            .batchSetNonStandardSelectors
            .selector;
        addFacet(diamond, address(registry), functionSelectors);
        registry = NonStandardSelectorsRegistryFacet(address(diamond));
    }

    function test_CanSetNonStandardSelector() public {
        registry.setNonStandardSelector(0x12345678, true);
        assert(registry.isNonStandardSelector(0x12345678));
    }

    function test_CanBatchSetNonStandardSelectors() public {
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0x12345678;
        selectors[1] = 0x87654321;
        bool[] memory isNonStandardSelectors = new bool[](2);
        isNonStandardSelectors[0] = true;
        isNonStandardSelectors[1] = false;
        registry.batchSetNonStandardSelectors(
            selectors,
            isNonStandardSelectors
        );
        assert(registry.isNonStandardSelector(0x12345678));
        assert(!registry.isNonStandardSelector(0x87654321));
    }

    function test_RevertIfNonOwnerCanSetNonStandardSelector() public {
        vm.startPrank(address(1337));
        vm.expectRevert(OnlyContractOwner.selector);
        registry.setNonStandardSelector(0x12345678, true);

        // Batch check
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = 0x12345678;
        selectors[1] = 0x87654321;
        bool[] memory isNonStandardSelectors = new bool[](2);
        isNonStandardSelectors[0] = true;
        isNonStandardSelectors[1] = false;
        vm.expectRevert(OnlyContractOwner.selector);
        registry.batchSetNonStandardSelectors(
            selectors,
            isNonStandardSelectors
        );
        vm.stopPrank();
    }
}
