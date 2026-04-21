// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { TestBase } from "../utils/TestBase.sol";

contract DiamondLoupeFacetTest is TestBase {
    DiamondLoupeFacet internal loupe;

    bytes4 internal constant IID_IDIAMOND_LOUPE =
        type(IDiamondLoupe).interfaceId;
    bytes4 internal constant IID_IERC165 = 0x01ffc9a7;

    function setUp() public {
        initTestBase();
        // DiamondLoupeFacet is registered by createDiamond() inside initTestBase()
        loupe = DiamondLoupeFacet(address(diamond));
    }

    function test_FacetAddressesReturnsRegisteredFacets() public {
        address[] memory addresses = loupe.facetAddresses();
        assertGt(addresses.length, 0);
    }

    function test_FacetAddressesContainsDiamondLoupeFacet() public {
        IDiamondLoupe.Facet[] memory facets = loupe.facets();
        bool found = false;
        for (uint256 i = 0; i < facets.length; i++) {
            for (uint256 j = 0; j < facets[i].functionSelectors.length; j++) {
                if (
                    facets[i].functionSelectors[j] ==
                    DiamondLoupeFacet.facetAddresses.selector
                ) {
                    found = true;
                }
            }
        }
        assertTrue(found);
    }

    function test_SupportsInterfaceReturnsFalseForUnregisteredInterfaces() public {
        // supportedInterfaces mapping is never written — all return false
        assertFalse(loupe.supportsInterface(IID_IDIAMOND_LOUPE));
        assertFalse(loupe.supportsInterface(IID_IERC165));
        assertFalse(loupe.supportsInterface(bytes4(0xdeadbeef)));
    }
}
