// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LDADiamond } from "lifi/Periphery/LDA/LDADiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { EmergencyPauseFacet } from "lifi/Security/EmergencyPauseFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { BaseDiamondTest } from "../../../utils/BaseDiamondTest.sol";
import { TestBaseRandomConstants } from "../../../utils/TestBaseRandomConstants.sol";

/// @title LDADiamondTest
/// @notice Spins up a minimal LDA (LiFi DEX Aggregator) Diamond with loupe, ownership, and emergency pause facets for periphery tests.
/// @dev Child test suites inherit this to get a ready-to-cut diamond and helper to assemble facets.
contract LDADiamondTest is BaseDiamondTest, TestBaseRandomConstants {
    /// @notice The diamond proxy under test.
    LDADiamond internal ldaDiamond;

    /// @notice Deploys a clean LDA diamond with base facets and sets owner/pauser.
    /// @dev This runs before higher-level test setup in BaseCoreRouteTest/BaseDEXFacetTest.
    function setUp() public virtual {
        ldaDiamond = createLdaDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
    }

    /// @notice Creates an LDA diamond and wires up Loupe, Ownership and EmergencyPause facets.
    /// @param _diamondOwner Owner address for the diamond.
    /// @param _pauserWallet Pauser address for the emergency pause facet.
    /// @return diamond The newly created diamond instance.
    function createLdaDiamond(
        address _diamondOwner,
        address _pauserWallet
    ) internal returns (LDADiamond) {
        vm.startPrank(_diamondOwner);
        DiamondCutFacet diamondCut = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();
        OwnershipFacet ownership = new OwnershipFacet();
        EmergencyPauseFacet emergencyPause = new EmergencyPauseFacet(
            _pauserWallet
        );
        LDADiamond diamond = new LDADiamond(
            _diamondOwner,
            address(diamondCut)
        );

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupe));

        // Add Ownership
        _addOwnershipSelectors(address(ownership));

        // Add PeripheryRegistry TODO?!?!?

        // Add EmergencyPause (removeFacet, pause/unpause)
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPause.removeFacet.selector;
        functionSelectors[1] = emergencyPause.pauseDiamond.selector;
        functionSelectors[2] = emergencyPause.unpauseDiamond.selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(emergencyPause),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
        delete cut;
        vm.stopPrank();
        return diamond;
    }
}
