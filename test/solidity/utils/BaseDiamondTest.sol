// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { Test } from "forge-std/Test.sol";
import { TestBaseRandomConstants } from "./TestBaseRandomConstants.sol";

/// @title BaseDiamondTest
/// @notice Minimal helper to compose a test Diamond and add facets/selectors for test scenarios.
/// @dev Provides overloads to add facets with or without init calldata.
///      This contract is used by higher-level LDA test scaffolding to assemble the test Diamond.
abstract contract BaseDiamondTest is Test, TestBaseRandomConstants {
    LibDiamond.FacetCut[] internal cut;

    /// @notice Adds standard Diamond Loupe selectors to the `cut` buffer.
    /// @param _diamondLoupe Address of a deployed `DiamondLoupeFacet`.
    /// @dev Call this before invoking diamondCut with the buffered `cut`.
    function _addDiamondLoupeSelectors(address _diamondLoupe) internal {
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = DiamondLoupeFacet
            .facetFunctionSelectors
            .selector;
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

    /// @notice Adds standard Ownership selectors to the `cut` buffer.
    /// @param _ownership Address of a deployed `OwnershipFacet`.
    /// @dev Call this before invoking diamondCut with the buffered `cut`.
    function _addOwnershipSelectors(address _ownership) internal {
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = OwnershipFacet.transferOwnership.selector;
        functionSelectors[1] = OwnershipFacet.cancelOwnershipTransfer.selector;
        functionSelectors[2] = OwnershipFacet
            .confirmOwnershipTransfer
            .selector;
        functionSelectors[3] = OwnershipFacet.owner.selector;

        cut.push(
            LibDiamond.FacetCut({
                facetAddress: _ownership,
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );
    }

    /// @notice Adds a facet and function selectors to the target diamond.
    /// @param _diamond Address of the diamond proxy.
    /// @param _facet Address of the facet implementation to add.
    /// @param _selectors Function selectors to expose in the diamond.
    /// @dev Convenience overload with no initializer; see the 5-arg overload for init flows.
    function addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors
    ) public virtual {
        _addFacet(_diamond, _facet, _selectors, address(0), "");
    }

    /// @notice Adds a facet and function selectors to the target diamond, optionally executing an initializer.
    /// @param _diamond Address of the diamond proxy.
    /// @param _facet Address of the facet implementation to add.
    /// @param _selectors Function selectors to expose in the diamond.
    /// @param _init Address of an initializer (can be facet or another contract).
    /// @param _initCallData ABI-encoded calldata for the initializer.
    /// @dev Owner is impersonated via vm.startPrank for the duration of the diamondCut.
    function addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) public virtual {
        _addFacet(_diamond, _facet, _selectors, _init, _initCallData);
    }

    /// @notice Performs diamondCut with an appended `FacetCut`.
    /// @param _diamond Address of the diamond proxy.
    /// @param _facet Address of the facet implementation to add.
    /// @param _selectors Function selectors to expose in the diamond.
    /// @param _init Address of an initializer (address(0) for none).
    /// @param _initCallData ABI-encoded calldata for the initializer (empty if none).
    /// @dev Example:
    ///      - Append loupe + ownership cuts first.
    ///      - Then call `_addFacet(diamond, address(myFacet), selectors, address(0), "")`.
    function _addFacet(
        address _diamond,
        address _facet,
        bytes4[] memory _selectors,
        address _init,
        bytes memory _initCallData
    ) internal virtual {
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
