// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { Test } from "forge-std/Test.sol";

abstract contract BaseDiamondTest is Test {
    LibDiamond.FacetCut[] internal cut;

    // Common function to add Diamond Loupe selectors
    function _addDiamondLoupeSelectors(address _diamondLoupe) internal {
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        functionSelectors[1] = DiamondLoupeFacet.facets.selector;
        functionSelectors[2] = DiamondLoupeFacet.facetAddress.selector;
        functionSelectors[3] = DiamondLoupeFacet.facetAddresses.selector;
        functionSelectors[4] = DiamondLoupeFacet.supportsInterface.selector;

        cut.push(
            LibDiamond.FacetCut({
                facetAddress: _diamondLoupe,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );
    }

    // Common function to add Ownership selectors
    function _addOwnershipSelectors(address _ownership) internal {
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = OwnershipFacet.transferOwnership.selector;
        functionSelectors[1] = OwnershipFacet.cancelOwnershipTransfer.selector;
        functionSelectors[2] = OwnershipFacet.confirmOwnershipTransfer.selector;
        functionSelectors[3] = OwnershipFacet.owner.selector;

        cut.push(
            LibDiamond.FacetCut({
                facetAddress: _ownership,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );
    }

    // Common function to add a facet
    function addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors
    ) internal {
        _addFacet(_diamond, _facet, _selectors, address(0), "");
    }

    function addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) internal {
        _addFacet(_diamond, _facet, _selectors, _init, _initCallData);
    }

    function _addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) internal {
        vm.startPrank(OwnershipFacet(_diamond).owner());
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: _facet,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: _selectors
            })
        );

        DiamondCutFacet(_diamond).diamondCut(cut, _init, _initCallData);

        delete cut;
        vm.stopPrank();
    }
}
