// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title Non Standard Selectors Registry Facet
/// @author LIFI (https://li.finance)
/// @notice Registry for non-standard selectors
/// @custom:version 1.0.0
contract NonStandardSelectorsRegistryFacet {
    // Storage //
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.nonstandardselectorsregistry");

    // Types //
    struct Storage {
        mapping(bytes4 => bool) selectors;
    }

    // @notice set a selector as non-standard
    // @param _selector the selector to set
    // @param _isNonStandardSelector whether the selector is non-standard
    function setNonStandardSelector(
        bytes4 _selector,
        bool _isNonStandardSelector
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.selectors[_selector] = _isNonStandardSelector;
    }

    // @notice batch set selectors as non-standard
    // @param _selectors the selectors to set
    // @param _isNonStandardSelectors whether the selectors are non-standard
    function batchSetNonStandardSelectors(
        bytes4[] calldata _selectors,
        bool[] calldata _isNonStandardSelectors
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        require(
            _selectors.length == _isNonStandardSelectors.length,
            "NonStandardSelectorsRegistryFacet: selectors and isNonStandardSelectors length mismatch"
        );
        for (uint256 i = 0; i < _selectors.length; i++) {
            s.selectors[_selectors[i]] = _isNonStandardSelectors[i];
        }
    }

    // @notice check if a selector is non-standard
    // @param _selector the selector to check
    // @return whether the selector is non-standard
    function isNonStandardSelector(
        bytes4 _selector
    ) external view returns (bool) {
        return getStorage().selectors[_selector];
    }

    // Internal Functions //

    // @notice get the storage slot for the NonStandardSelectorsRegistry
    function getStorage() internal pure returns (Storage storage s) {
        bytes32 position = NAMESPACE;
        assembly {
            s.slot := position
        }
    }
}
