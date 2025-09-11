// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { InvalidContract, InvalidCallData } from "../Errors/GenericErrors.sol";
import { LibAsset } from "./LibAsset.sol";

/// @title LibAllowList
/// @author LI.FI (https://li.fi)
/// @notice Library for managing and accessing the contract address allow list
/// @custom:version 2.0.0
library LibAllowList {
    /// Storage ///
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.library.allow.list");

    struct AllowListStorage {
        mapping(address => bool) contractAllowList;
        mapping(bytes4 => bool) selectorAllowList;
        address[] contracts;
        mapping(address => uint256) contractToIndex;
        mapping(bytes4 => uint256) selectorToIndex;
        bytes4[] selectors;
        mapping(address => mapping(bytes4 => bool)) contractSelectorAllowList;
        mapping(bytes4 => uint256) selectorReferenceCount;
        mapping(address => bytes4[]) whitelistedSelectorsByContract; // The length of this array also serves as the implicit contract reference count.
        mapping(address => mapping(bytes4 => uint256)) selectorIndices; // 1-based index
        bool migrated;
    }

    /// @dev Adds a specific contract-selector pair to the allow list.
    /// @param _contract the contract address to add
    /// @param _selector the function selector to add
    function addAllowedContractSelector(address _contract, bytes4 _selector) internal {
        // validate contract address is not zero address
        if (_contract == address(0)) revert InvalidCallData();

        AllowListStorage storage als = _getStorage();

        if (als.contractSelectorAllowList[_contract][_selector]) return;

        // 1. Update source of truth
        als.contractSelectorAllowList[_contract][_selector] = true;

        // 2. Use the iterable list's length as the contract reference count.
        // If the length is 0, this is the first selector for this contract.
        if (als.whitelistedSelectorsByContract[_contract].length == 0) {
            _addAllowedContract(_contract);
        }

        // 3. Update the global selector reference count.
        if (++als.selectorReferenceCount[_selector] == 1) {
            _addAllowedSelector(_selector);
        }

        // 4. Update iterable list for the getter function.
        als.whitelistedSelectorsByContract[_contract].push(_selector);
        als.selectorIndices[_contract][_selector] = als.whitelistedSelectorsByContract[_contract].length;
    }

    /// @dev Removes a specific contract-selector pair from the new allow list.
    /// @param _contract the contract address to remove
    /// @param _selector the function selector to remove
    function removeAllowedContractSelector(address _contract, bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();
        if (!als.contractSelectorAllowList[_contract][_selector]) return;

        // 1. Update source of truth
        delete als.contractSelectorAllowList[_contract][_selector];

        // 2. Update iterable list for the getter function first.
        _removeSelectorFromIterableList(_contract, _selector);

        // 3. Use the iterable list's new length as the contract reference count.
        // If the length is now 0, it was the last selector for this contract.
        if (als.whitelistedSelectorsByContract[_contract].length == 0) {
            _removeAllowedContract(_contract);
        }

        // 4. Update the global selector reference count.
        if (--als.selectorReferenceCount[_selector] == 0) {
            _removeAllowedSelector(_selector);
        }
    }

    /// View Functions ///

    function getWhitelistedSelectorsForContract(address _contract) internal view returns (bytes4[] memory) {
        return _getStorage().whitelistedSelectorsByContract[_contract];
    }

    function contractSelectorIsAllowed(address _contract, bytes4 _selector) internal view returns (bool) {
        return _getStorage().contractSelectorAllowList[_contract][_selector];
    }

    /// @dev Returns if selector has been added to the allow list
    /// @param _selector the selector to check
    function selectorIsAllowed(bytes4 _selector) internal view returns (bool) {
        return _getStorage().selectorToIndex[_selector] > 0;
    }

    /// @dev LEGACY: Returns if contract has been added to the allow list
    /// @param _contract the contract to check
    function contractIsAllowed(address _contract) internal view returns (bool) {
        return _getStorage().contractToIndex[_contract] > 0;
    }

    /// @dev LEGACY:Fetch contract addresses from the allow list
    function getAllowedContracts() internal view returns (address[] memory) {
        return _getStorage().contracts;
    }

    /// @dev LEGACY: Fetch all allowed selectors
    function getAllowedSelectors() internal view returns (bytes4[] memory) {
        return _getStorage().selectors;
    }

    /// Private Helpers ///

    /// @dev Adds a contract address to the allow list
    /// @param _contract the contract address to add
    function _addAllowedContract(address _contract) internal {
        // ensure address is actually a contract (does NOT include EIP-7702 AA wallets)
        if (!LibAsset.isContract(_contract)) revert InvalidContract();

        AllowListStorage storage als = _getStorage();

        // skip if contract is already in allow list (1-based index)
        if (als.contractToIndex[_contract] > 0) return;

        // add contract to allow list array
        als.contracts.push(_contract);
        // store 1-based index for efficient removal later
        als.contractToIndex[_contract] = als.contracts.length;
    }

    /// @dev Remove a contract address from the allow list
    /// @param _contract the contract address to remove
    function _removeAllowedContract(address _contract) internal {
        AllowListStorage storage als = _getStorage();

        // get the 1-based index, return if not found
        uint256 oneBasedIndex = als.contractToIndex[_contract];
        if (oneBasedIndex == 0) {
            // legacy cleanup: clear stale boolean if present
            als.contractAllowList[_contract] = false;
            return;
        }

        // convert to 0-based index for array operations
        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.contracts.length - 1;

        // if the contract to remove isn't the last one,
        // move the last contract to the removed contract's position
        if (index != lastIndex) {
            address lastContract = als.contracts[lastIndex];
            als.contracts[index] = lastContract;
            als.contractToIndex[lastContract] = oneBasedIndex;
        }

        // remove the last element and clean up mappings
        als.contracts.pop();
        delete als.contractToIndex[_contract];
    }

    function _addAllowedSelector(bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();
        als.selectors.push(_selector);
        als.selectorToIndex[_selector] = als.selectors.length;
    }

    function _removeAllowedSelector(bytes4 _selector) private {
        AllowListStorage storage als = _getStorage();
        uint256 oneBasedIndex = als.selectorToIndex[_selector];
        if (oneBasedIndex == 0) return;
        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.selectors.length - 1;
        if (index != lastIndex) {
            bytes4 lastSelector = als.selectors[lastIndex];
            als.selectors[index] = lastSelector;
            als.selectorToIndex[lastSelector] = oneBasedIndex;
        }
        als.selectors.pop();
        delete als.selectorToIndex[_selector];
    }
    
    function _removeSelectorFromIterableList(address _contract, bytes4 _selector) private {
        AllowListStorage storage als = _getStorage();
        uint256 oneBasedIndex = als.selectorIndices[_contract][_selector];
        if (oneBasedIndex == 0) return;
        uint256 index = oneBasedIndex - 1;
        bytes4[] storage selectorsArray = als.whitelistedSelectorsByContract[_contract];
        uint256 lastIndex = selectorsArray.length - 1;

        if (index != lastIndex) {
            bytes4 lastSelector = selectorsArray[lastIndex];
            selectorsArray[index] = lastSelector;
            als.selectorIndices[_contract][lastSelector] = oneBasedIndex;
        }
        selectorsArray.pop();
        delete als.selectorIndices[_contract][_selector];
    }

    function _getStorage() internal pure returns (AllowListStorage storage als) {
        bytes32 position = NAMESPACE;
        assembly {
            als.slot := position
        }
    }
}
