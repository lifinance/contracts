// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import "lifi/LiFiDiamond.sol";
import "lifi/Facets/DiamondCutFacet.sol";
import "lifi/Facets/DiamondLoupeFacet.sol";
import "lifi/Facets/OwnershipFacet.sol";
import "lifi/Interfaces/IDiamondCut.sol";
import "lifi/Facets/PeripheryRegistryFacet.sol";

contract DiamondTest {
    IDiamondCut.FacetCut[] internal cut;

    function createDiamond() internal returns (LiFiDiamond) {
        DiamondCutFacet diamondCut = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();
        OwnershipFacet ownership = new OwnershipFacet();
        PeripheryRegistryFacet periphery = new PeripheryRegistryFacet();
        LiFiDiamond diamond = new LiFiDiamond(
            address(this),
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

        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");

        delete cut;

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
    }
}
