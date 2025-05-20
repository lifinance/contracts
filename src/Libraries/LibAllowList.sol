// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { InvalidContract } from "../Errors/GenericErrors.sol";

/// @title Lib Allow List
/// @author LI.FI (https://li.fi)
/// @notice Library for managing and accessing the conract address allow list
/// @custom:version 1.0.1
library LibAllowList {
    /// Storage ///
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.library.allow.list.v2");

    struct AllowListStorage {
        mapping(address => bool) contractAllowList;
        mapping(bytes4 => bool) selectorAllowList;
        mapping(address => uint256) contractToIndex;
        mapping(bytes4 => uint256) selectorToIndex;
        address[] contracts;
        bytes4[] selectors;
    }

    /// @dev Adds a contract address to the allow list
    /// @param _contract the contract address to add
    function addAllowedContract(address _contract) internal {
        _checkAddress(_contract);

        AllowListStorage storage als = _getStorage();

        if (als.contractAllowList[_contract]) return;

        als.contractAllowList[_contract] = true;
        als.contracts.push(_contract);
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

        if (!als.contractAllowList[_contract]) {
            return;
        }

        uint256 oneBasedIndex = als.contractToIndex[_contract];
        if (oneBasedIndex == 0) return;

        uint256 index = oneBasedIndex - 1;
        uint256 lastIndex = als.contracts.length - 1;

        if (index != lastIndex) {
            address lastContract = als.contracts[lastIndex];
            als.contracts[index] = lastContract;
            als.contractToIndex[lastContract] = oneBasedIndex;
        }

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

        if (als.selectorAllowList[_selector]) return;

        als.selectorAllowList[_selector] = true;
        als.selectors.push(_selector);
        als.selectorToIndex[_selector] = als.selectors.length;
    }

    /// @dev Removes a selector from the allow list
    /// @param _selector the selector to remove
    function removeAllowedSelector(bytes4 _selector) internal {
        AllowListStorage storage als = _getStorage();

        if (!als.selectorAllowList[_selector]) {
            return;
        }

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

    /// @dev Contains business logic for validating a contract address.
    /// @param _contract address of the dex to check
    function _checkAddress(address _contract) private view {
        if (_contract == address(0)) revert InvalidContract();

        if (_contract.code.length == 0) revert InvalidContract();
    }
}
