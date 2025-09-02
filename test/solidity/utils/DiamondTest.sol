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
    LiFiDiamond internal diamond;
    DiamondCutFacet internal diamondCutFacet;
    DiamondLoupeFacet internal diamondLoupeFacet;
    OwnershipFacet internal ownershipFacet;
    PeripheryRegistryFacet internal peripheryFacet;
    EmergencyPauseFacet internal emergencyPauseFacet;

    function setUp() public virtual {
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        peripheryFacet = new PeripheryRegistryFacet();
        emergencyPauseFacet = new EmergencyPauseFacet(USER_PAUSER);
        createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
    }

    function createDiamond(
        address _diamondOwner,
        address _pauserWallet
    ) internal returns (LiFiDiamond) {
        vm.startPrank(USER_DIAMOND_OWNER);
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        peripheryFacet = new PeripheryRegistryFacet();
        emergencyPauseFacet = new EmergencyPauseFacet(_pauserWallet);
        diamond = new LiFiDiamond(_diamondOwner, address(diamondCutFacet));

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupeFacet));

        // Add Ownership
        _addOwnershipSelectors(address(ownershipFacet));

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
                facetAddress: address(peripheryFacet),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Add EmergencyPause
        functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPauseFacet.removeFacet.selector;
        functionSelectors[1] = emergencyPauseFacet.pauseDiamond.selector;
        functionSelectors[2] = emergencyPauseFacet.unpauseDiamond.selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(emergencyPauseFacet),
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
