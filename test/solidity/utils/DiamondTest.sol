// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import "lifi/LiFiDiamond.sol";
import "lifi/Facets/DiamondCutFacet.sol";
import "lifi/Facets/DiamondLoupeFacet.sol";
import "lifi/Facets/OwnershipFacet.sol";
import "lifi/Facets/EmergencyPauseFacet.sol";
import "lifi/Interfaces/IDiamondCut.sol";
import "lifi/Facets/PeripheryRegistryFacet.sol";
import { Test } from "forge-std/Test.sol";

contract DiamondTest is Test {
    IDiamondCut.FacetCut[] internal cut;

    function createDiamond(
        address diamondOwner,
        address _pauserWallet
    ) internal returns (LiFiDiamond) {
        vm.startPrank(diamondOwner);
        DiamondCutFacet diamondCut = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();
        OwnershipFacet ownership = new OwnershipFacet();
        PeripheryRegistryFacet periphery = new PeripheryRegistryFacet();
        EmergencyPauseFacet emergencyPause = new EmergencyPauseFacet(
            _pauserWallet
        );
        LiFiDiamond diamond = new LiFiDiamond(
            diamondOwner,
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
            IDiamondCut.FacetCut({
                facetAddress: address(diamondLoupe),
                action: IDiamondCut.FacetCutAction.Add,
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
            IDiamondCut.FacetCut({
                facetAddress: address(ownership),
                action: IDiamondCut.FacetCutAction.Add,
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
            IDiamondCut.FacetCut({
                facetAddress: address(periphery),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // EmergencyPauseFacet
        functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPause.removeFacet.selector;
        functionSelectors[1] = emergencyPause.pauseDiamond.selector;
        functionSelectors[2] = emergencyPause.unpauseDiamond.selector;

        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(emergencyPause),
                action: IDiamondCut.FacetCutAction.Add,
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
            IDiamondCut.FacetCut({
                facetAddress: _facet,
                action: IDiamondCut.FacetCutAction.Add,
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
