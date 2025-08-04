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
        bool migrated;
    }

    /// @dev Adds a contract address to the allow list
    /// @param _contract the contract address to add
    function addAllowedContract(address _contract) internal {
        // validate contract address is not zero address
        if (_contract == address(0)) revert InvalidCallData();
        // ensure address is actually a contract (including EIP-7702 AA wallets)
        if (!LibAsset.isContract(_contract)) revert InvalidContract();

        AllowListStorage storage als = _getStorage();

        // skip if contract is already in allow list
        if (als.contractAllowList[_contract]) return;

        // add contract to allow list mapping and array
        als.contractAllowList[_contract] = true;
        als.contracts.push(_contract);
        // store 1-based index for efficient removal later
        als.contractToIndex[_contract] = als.contracts.length;
    }

    /// @dev Checks whether a contract address has been added to the allow list
    /// @param _contract the contract address to check
    function contractIsAllowed(
        address _contract
    ) internal view returns (bool) {
        return _getStorage().contractAllowList[_contract];
    }

    /// @dev Remove a contract address from the allow list
    /// @param _contract the contract address to remove
    function removeAllowedContract(address _contract) internal {
        AllowListStorage storage als = _getStorage();

        // skip if contract is not in allow list
        if (!als.contractAllowList[_contract]) {
            return;
        }

        // get the 1-based index, return if not found
        uint256 oneBasedIndex = als.contractToIndex[_contract];
        if (oneBasedIndex == 0) return;

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
        als.contractAllowList[_contract] = false;
    }

    /// @dev Fetch contract addresses from the allow list
    function getAllowedContracts() internal view returns (address[] memory) {
        return _getStorage().contracts;
    }

    /// @dev Add a selector to the allow list
    /// @param _selector the selector to add
    function addAllowedSelector(bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();
        // skip if selector is already in allow list
        if (als.selectorAllowList[_selector]) return;

        // add selector to allow list mapping and array
        als.selectorAllowList[_selector] = true;
        als.selectors.push(_selector);
        // store 1-based index for efficient removal later
        als.selectorToIndex[_selector] = als.selectors.length;
    }

    /// @dev Removes a selector from the allow list
    /// @param _selector the selector to remove
    function removeAllowedSelector(bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();

        // skip if selector is not in allow list
        if (!als.selectorAllowList[_selector]) {
            return;
        }

        // get the 1-based index, return if not found
        uint256 oneBasedIndex = als.selectorToIndex[_selector];
        if (oneBasedIndex == 0) return;

        // convert to 0-based index for array operations
        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.selectors.length - 1;

        // if the selector to remove isn't the last one,
        // move the last selector to the removed selector's position
        if (index != lastIndex) {
            bytes4 lastSelector = als.selectors[lastIndex];
            als.selectors[index] = lastSelector;
            als.selectorToIndex[lastSelector] = oneBasedIndex;
        }

        // remove the last element and clean up mappings
        als.selectors.pop();
        delete als.selectorToIndex[_selector];
        als.selectorAllowList[_selector] = false;
    }

    /// @dev Returns if selector has been added to the allow list
    /// @param _selector the selector to check
    function selectorIsAllowed(bytes4 _selector) internal view returns (bool) {
        return _getStorage().selectorAllowList[_selector];
    }

    /// @dev Fetch all allowed selectors
    function getAllowedSelectors() internal view returns (bytes4[] memory) {
        return _getStorage().selectors;
    }

    /// @dev Fetch local storage struct
    function _getStorage()
        internal
        pure
        returns (AllowListStorage storage als)
    {
        bytes32 position = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            als.slot := position
        }
    }
}
