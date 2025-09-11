// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { InvalidContract, InvalidCallData } from "../Errors/GenericErrors.sol";
import { LibAsset } from "./LibAsset.sol";

/// @title LibAllowList
/// @author LI.FI (https://li.fi)
/// @notice Manages a dual-model allow list to support a secure, granular permissions system
/// while maintaining backward compatibility with a non-granular, global system.
/// @dev This library is the single source of truth for all whitelist state changes.
/// It ensures that both the new granular mapping and the global arrays used by older
/// contracts are kept perfectly synchronized. The long-term goal is to migrate all usage
/// to the new granular system. New development should exclusively use the "Primary Interface" functions.
/// @custom:version 2.0.0
library LibAllowList {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.library.allow.list");

    struct AllowListStorage {
        // --- STORAGE FOR OLDER VERSIONS ---
        /// @dev [V1 DATA] Unused boolean mapping. Kept for storage layout compatibility.
        mapping(address => bool) contractAllowList;
        /// @dev [V1 DATA] Unused boolean mapping. Kept for storage layout compatibility.
        mapping(bytes4 => bool) selectorAllowList;
        /// @dev [BACKWARD COMPATIBILITY] The global list of all unique whitelisted contracts for older facets.
        address[] contracts;

        // --- NEW GRANULAR STORAGE & SYNCHRONIZATION ---
        // These variables form the new, secure, and preferred whitelist system.

        /// @dev [BACKWARD COMPATIBILITY] 1-based index for `contracts` array for efficient removal.
        mapping(address => uint256) contractToIndex;
        /// @dev [BACKWARD COMPATIBILITY] 1-based index for `selectors` array for efficient removal.
        mapping(bytes4 => uint256) selectorToIndex;
        /// @dev [BACKWARD COMPATIBILITY] The global list of all unique whitelisted selectors for older facets.
        bytes4[] selectors;
        /// @dev The SOURCE OF TRUTH for the new granular system.
        mapping(address => mapping(bytes4 => bool)) contractSelectorAllowList;
        /// @dev A global reference count for each selector to manage the `selectors` array for backward compatibility.
        mapping(bytes4 => uint256) selectorReferenceCount;
        /// @dev Iterable list of selectors for each contract, used by the backend getter.
        /// The length of this array also serves as the IMPLICIT contract reference count.
        mapping(address => bytes4[]) whitelistedSelectorsByContract;
        /// @dev 1-based index for `whitelistedSelectorsByContract` array for efficient removal.
        mapping(address => mapping(bytes4 => uint256)) selectorIndices;

        /// @dev Flag to indicate completion of a one-time data migration.
        bool migrated;
    }

    ///  Primary Interface ///

    // All new contracts and facets should exclusively use these functions. They operate
    // on the granular `contractSelectorAllowList` and handle all synchronization logic.

    /// @notice Adds a specific contract-selector pair to the allow list.
    /// @dev This is the primary entry point for whitelisting. It updates the granular
    /// mapping and synchronizes the global arrays (for backward compatibility) via reference counting.
    /// @param _contract The contract address.
    /// @param _selector The function selector.
    function addAllowedContractSelector(address _contract, bytes4 _selector) internal {
        // Validate contract address is not zero address.
        if (_contract == address(0)) revert InvalidCallData();
        AllowListStorage storage als = _getStorage();

        // Skip if the pair is already allowed.
        if (als.contractSelectorAllowList[_contract][_selector]) return;

        // 1. Update the source of truth for the new system.
        als.contractSelectorAllowList[_contract][_selector] = true;

        // 2. Update the `contracts` array if this is the first selector for this contract.
        // We use the length of the iterable array as an implicit reference count.
        if (als.whitelistedSelectorsByContract[_contract].length == 0) {
            _addAllowedContract(_contract);
        }

        // 3. Update the `selectors` array if this is the first time this selector is used globally.
        if (++als.selectorReferenceCount[_selector] == 1) {
            _addAllowedSelector(_selector);
        }

        // 4. Update the iterable list used by the on-chain getter.
        als.whitelistedSelectorsByContract[_contract].push(_selector);
        // Store 1-based index for efficient removal later.
        als.selectorIndices[_contract][_selector] = als.whitelistedSelectorsByContract[_contract].length;
    }

    /// @notice Removes a specific contract-selector pair from the allow list.
    /// @dev This is the primary entry point for removal. It updates the granular
    /// mapping and synchronizes the global arrays (for backward compatibility) via reference counting.
    /// @param _contract The contract address.
    /// @param _selector The function selector.
    function removeAllowedContractSelector(address _contract, bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();
        // Skip if the pair is not currently allowed.
        if (!als.contractSelectorAllowList[_contract][_selector]) return;

        // 1. Update the source of truth.
        delete als.contractSelectorAllowList[_contract][_selector];

        // 2. Update the iterable list FIRST to get the new length.
        _removeSelectorFromIterableList(_contract, _selector);

        // 3. If the iterable list's new length is 0, it was the last selector,
        // so remove the contract from the global list.
        if (als.whitelistedSelectorsByContract[_contract].length == 0) {
            _removeAllowedContract(_contract);
        }

        // 4. If the global reference count is now 0, it was the last usage of this
        // selector, so remove it from the global list.
        if (--als.selectorReferenceCount[_selector] == 0) {
            _removeAllowedSelector(_selector);
        }
    }

    /// @notice Checks if a specific contract-selector pair is allowed.
    /// @dev This is the preferred check for all new contracts.
    /// @param _contract The contract address.
    /// @param _selector The function selector.
    /// @return isAllowed True if the contract-selector pair is allowed, false otherwise.
    function contractSelectorIsAllowed(address _contract, bytes4 _selector) internal view returns (bool) {
        return _getStorage().contractSelectorAllowList[_contract][_selector];
    }

    /// @notice Gets all approved selectors for a specific contract.
    /// @dev Used by the on-chain getter in the facet for backend synchronization.
    /// @param _contract The contract address.
    /// @return selectors The whitelisted selectors for the contract.
    function getWhitelistedSelectorsForContract(address _contract) internal view returns (bytes4[] memory) {
        return _getStorage().whitelistedSelectorsByContract[_contract];
    }


    /// Backward Compatibility Interface ///

    // These functions read from the global arrays. They are required for existing,
    // deployed facets to continue functioning. They should be considered part of a
    // transitional phase and MUST NOT be used in new development.

    /// @notice [Backward Compatibility] Checks if a contract is on the global allow list.
    /// @dev This function reads from the global list and is NOT granular. It is required for
    /// older, deployed facets to function correctly. Avoid use in new code.
    /// @param _contract The contract address.
    /// @return isAllowed True if the contract is allowed, false otherwise.
    function contractIsAllowed(address _contract) internal view returns (bool) {
        return _getStorage().contractToIndex[_contract] > 0;
    }

    /// @notice [Backward Compatibility] Checks if a selector is on the global allow list.
    /// @dev This function reads from the global list and is NOT granular. It is required for
    /// older, deployed facets to function correctly. Avoid use in new code.
    /// @param _selector The function selector.
    /// @return isAllowed True if the selector is allowed, false otherwise.
    function selectorIsAllowed(bytes4 _selector) internal view returns (bool) {
        return _getStorage().selectorToIndex[_selector] > 0;
    }

    /// @notice [Backward Compatibility] Gets the entire global list of whitelisted contracts.
    /// @return contracts The global list of whitelisted contracts.
    function getAllowedContracts() internal view returns (address[] memory) {
        return _getStorage().contracts;
    }

    /// @notice [Backward Compatibility] Gets the entire global list of whitelisted selectors.
    function getAllowedSelectors() internal view returns (bytes4[] memory) {
        return _getStorage().selectors;
    }

    /// Private Helpers (Internal Use Only) ///

    /// @dev Internal helper to add a contract to the `contracts` array.
    /// @param _contract The contract address.
    function _addAllowedContract(address _contract) private {
        // Ensure address is actually a contract.
        if (!LibAsset.isContract(_contract)) revert InvalidContract();
        AllowListStorage storage als = _getStorage();

        // Skip if contract is already in allow list (1-based index).
        if (als.contractToIndex[_contract] > 0) return;

        // Add contract to allow list array.
        als.contracts.push(_contract);
        // Store 1-based index for efficient removal later.
        als.contractToIndex[_contract] = als.contracts.length;
    }

    /// @dev Internal helper to remove a contract from the `contracts` array.
    /// @param _contract The contract address.
    function _removeAllowedContract(address _contract) private {
        AllowListStorage storage als = _getStorage();
        // Get the 1-based index; return if not found.
        uint256 oneBasedIndex = als.contractToIndex[_contract];
        if (oneBasedIndex == 0) {
            // Legacy cleanup: clear stale boolean if present.
            als.contractAllowList[_contract] = false;
            return;
        }
        // Convert to 0-based index for array operations.
        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.contracts.length - 1;

        // If the contract to remove isn't the last one,
        // move the last contract to the removed contract's position.
        if (index != lastIndex) {
            address lastContract = als.contracts[lastIndex];
            als.contracts[index] = lastContract;
            als.contractToIndex[lastContract] = oneBasedIndex;
        }
        // Remove the last element and clean up mappings.
        als.contracts.pop();
        delete als.contractToIndex[_contract];
    }

    /// @dev Internal helper to add a selector to the `selectors` array.
    /// @param _selector The function selector.
    function _addAllowedSelector(bytes4 _selector) private {
        AllowListStorage storage als = _getStorage();
        // Skip if selector is already in allow list (1-based index).
        if (als.selectorToIndex[_selector] > 0) return;
        // Add selector to the array.
        als.selectors.push(_selector);
        // Store 1-based index for efficient removal later.
        als.selectorToIndex[_selector] = als.selectors.length;
    }

    /// @dev Internal helper to remove a selector from the `selectors` array.
    /// @param _selector The function selector.
    function _removeAllowedSelector(bytes4 _selector) private {
        AllowListStorage storage als = _getStorage();
        // Get the 1-based index; return if not found.
        uint256 oneBasedIndex = als.selectorToIndex[_selector];
        if (oneBasedIndex == 0) return;
        // Convert to 0-based index for array operations.
        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.selectors.length - 1;

        // If the selector to remove isn't the last one,
        // move the last selector to the removed selector's position.
        if (index != lastIndex) {
            bytes4 lastSelector = als.selectors[lastIndex];
            als.selectors[index] = lastSelector;
            als.selectorToIndex[lastSelector] = oneBasedIndex;
        }
        // Remove the last element and clean up mappings.
        als.selectors.pop();
        delete als.selectorToIndex[_selector];
    }
    
    /// @dev Internal helper to manage the iterable array for the getter function.
    /// @param _contract The contract address.
    /// @param _selector The function selector.
    function _removeSelectorFromIterableList(address _contract, bytes4 _selector) private {
        AllowListStorage storage als = _getStorage();
        // Get the 1-based index; return if not found.
        uint256 oneBasedIndex = als.selectorIndices[_contract][_selector];
        if (oneBasedIndex == 0) return;
        // Convert to 0-based index for array operations.
        uint256 index = oneBasedIndex - 1;
        bytes4[] storage selectorsArray = als.whitelistedSelectorsByContract[_contract];
        uint256 lastIndex = selectorsArray.length - 1;

        // If the selector to remove isn't the last one,
        // move the last selector to the removed selector's position.
        if (index != lastIndex) {
            bytes4 lastSelector = selectorsArray[lastIndex];
            selectorsArray[index] = lastSelector;
            als.selectorIndices[_contract][lastSelector] = oneBasedIndex;
        }
        // Remove the last element and clean up mappings.
        selectorsArray.pop();
        delete als.selectorIndices[_contract][_selector];
    }

    /// @dev Fetches the storage pointer for this library.
    /// @return als The storage pointer.
    function _getStorage() internal pure returns (AllowListStorage storage als) {
        bytes32 position = NAMESPACE;
        assembly {
            als.slot := position
        }
    }
}

