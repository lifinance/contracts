// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { BaseDiamondTest } from "../../utils/BaseDiamondTest.sol";

/// @notice Spins up a minimal LDA (LiFi DEX Aggregator) Diamond with loupe, ownership, and emergency pause facets for periphery tests.
contract LiFiDEXAggregatorDiamondTest is BaseDiamondTest {
    LiFiDEXAggregatorDiamond public ldaDiamond;

    function setUp() public virtual override {
        super.setUp(); // This creates the main LiFiDiamond as 'diamond'

        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_DIAMOND_OWNER,
            address(diamondCutFacet)
        );

        // prepare function selector for diamondCut (OwnershipFacet)
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = ownershipFacet.owner.selector;

        // prepare parameters for diamondCut (OwnershipFacet)
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(ownershipFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        vm.prank(USER_DIAMOND_OWNER);
        DiamondCutFacet(address(ldaDiamond)).diamondCut(cut, address(0), "");
    }

    function test_DeploysWithoutErrors() public virtual override {
        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_DIAMOND_OWNER,
            address(diamondCutFacet)
        );
        super.test_DeploysWithoutErrors();
    }
}
