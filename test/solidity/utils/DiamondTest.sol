// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { BaseDiamondTest } from "./BaseDiamondTest.sol";

contract DiamondTest is BaseDiamondTest {
    function createDiamond(
        address _diamondOwner,
        address _pauserWallet
    ) internal returns (LiFiDiamond) {
        vm.startPrank(_diamondOwner);
        DiamondCutFacet diamondCut = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();
        OwnershipFacet ownership = new OwnershipFacet();
        PeripheryRegistryFacet periphery = new PeripheryRegistryFacet();
        EmergencyPauseFacet emergencyPause = new EmergencyPauseFacet(
            _pauserWallet
        );
        LiFiDiamond diamond = new LiFiDiamond(
            _diamondOwner,
            address(diamondCut)
        );

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupe));

        // Add Ownership
        _addOwnershipSelectors(address(ownership));

        // Add PeripheryRegistry
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = PeripheryRegistryFacet
            .registerPeripheryContract
            .selector;
        functionSelectors[1] = PeripheryRegistryFacet
            .getPeripheryContract
            .selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(periphery),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Add EmergencyPause
        functionSelectors = new bytes4[](3);
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
