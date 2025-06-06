// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { Test } from "forge-std/Test.sol";

contract DiamondTest is Test {
    LibDiamond.FacetCut[] internal cut;

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

        bytes4[] memory functionSelectors;

        // Diamond Loupe

        functionSelectors = new bytes4[](5);
        functionSelectors[0] = DiamondLoupeFacet
            .facetFunctionSelectors
            .selector;
        functionSelectors[1] = DiamondLoupeFacet.facets.selector;
        functionSelectors[2] = DiamondLoupeFacet.facetAddress.selector;
        functionSelectors[3] = DiamondLoupeFacet.facetAddresses.selector;
        functionSelectors[4] = DiamondLoupeFacet.supportsInterface.selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(diamondLoupe),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Ownership Facet

        functionSelectors = new bytes4[](4);
        functionSelectors[0] = OwnershipFacet.transferOwnership.selector;
        functionSelectors[1] = OwnershipFacet.cancelOwnershipTransfer.selector;
        functionSelectors[2] = OwnershipFacet
            .confirmOwnershipTransfer
            .selector;
        functionSelectors[3] = OwnershipFacet.owner.selector;

        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(ownership),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // PeripheryRegistryFacet
        functionSelectors = new bytes4[](2);
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

        // EmergencyPauseFacet
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

    function addFacet(
        LiFiDiamond _diamond,
        address _facet,
        bytes4[] memory _selectors
    ) internal {
        _addFacet(_diamond, _facet, _selectors, address(0), "");
    }

    function addFacet(
        LiFiDiamond _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) internal {
        _addFacet(_diamond, _facet, _selectors, _init, _initCallData);
    }

    function _addFacet(
        LiFiDiamond _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) internal {
        vm.startPrank(OwnershipFacet(address(_diamond)).owner());
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: _facet,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: _selectors
            })
        );

        DiamondCutFacet(address(_diamond)).diamondCut(
            cut,
            _init,
            _initCallData
        );

        delete cut;
        vm.stopPrank();
    }
}
