// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { CommonDiamondTest } from "./CommonDiamondTest.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

/// @title LiFiDEXAggregatorDiamondTest
/// @notice Spins up a minimal LDA (LiFi DEX Aggregator) Diamond with loupe, ownership, and emergency pause facets for periphery tests.
/// @dev Child test suites inherit this to get a ready-to-cut diamond and helper to assemble facets.
contract LiFiDEXAggregatorDiamondTest is CommonDiamondTest {
    LiFiDEXAggregatorDiamond public ldaDiamond;

    function setUp() public virtual override {
        super.setUp(); // This creates the main LiFiDiamond as 'diamond'

        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_LDA_DIAMOND_OWNER,
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

        vm.prank(USER_LDA_DIAMOND_OWNER);
        DiamondCutFacet(address(ldaDiamond)).diamondCut(cut, address(0), "");
    }

    function test_DeploysWithoutErrors() public virtual override {
        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_LDA_DIAMOND_OWNER,
            address(diamondCutFacet)
        );
        super.test_DeploysWithoutErrors();
    }

    /// @notice Test that LiFiDEXAggregatorDiamond reverts when constructed with zero address owner
    function testRevert_LiFiDEXAggregatorDiamondConstructedWithZeroAddressOwner()
        public
    {
        vm.expectRevert(InvalidConfig.selector);
        new LiFiDEXAggregatorDiamond(
            address(0), // This should trigger InvalidConfig
            address(diamondCutFacet)
        );
    }
}
