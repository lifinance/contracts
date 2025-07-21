// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { IWhitelistManagerFacet } from "../Interfaces/IWhitelistManagerFacet.sol";
import { CannotAuthoriseSelf, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title WhitelistManagerFacet
/// @author LI.FI (https://li.fi)
/// @notice Facet contract for managing whitelisted addresses for various protocol interactions.
/// @custom:version 1.0.0
/// @dev This facet replaces the legacy DexManagerFacet to address several limitations:
/// 1. Broader Scope: While DexManagerFacet suggested management of only DEX contracts,
///    this facet accurately reflects its role in managing whitelists for all types of protocols
///    (DEXes, bridges, etc.)
/// 2. Storage Improvement: Implements a new LibAllowList storage layout, separating it from
///    the legacy implementation
/// 3. Complete onchain Data: Stores all whitelisted function selectors onchain, preventing
///    fragmented offchain data management that existed in the previous implementation
/// 4. Consistent Naming: Standardizes terminology around "whitelist" instead of mixing
///    "approved" and "whitelist"
contract WhitelistManagerFacet is IWhitelistManagerFacet {
    /// External Methods ///

    /// @inheritdoc IWhitelistManagerFacet
    function addToWhitelist(address _contractAddress) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _addToWhitelist(_contractAddress);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchAddToWhitelist(address[] calldata _addresses) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _addresses.length;

        for (uint256 i = 0; i < length; ++i) {
            _addToWhitelist(_addresses[i]);
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
    function removeFromWhitelist(address _address) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _removeFromWhitelist(_address);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchRemoveFromWhitelist(address[] calldata _addresses) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _addresses.length;
        for (uint256 i = 0; i < length; ++i) {
            _removeFromWhitelist(_addresses[i]);
        }
    }

    /// @notice Adds or removes a specific function selector to/from the whitelist.
    /// @param _selector The function selector to whitelist or unwhitelist.
    /// @param _whitelisted Whether the function selector should be whitelisted.
    function setFunctionWhitelistBySelector(
        bytes4 _selector,
        bool _whitelisted
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _setFunctionWhitelist(_selector, _whitelisted);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchSetFunctionWhitelistBySelector(
        bytes4[] calldata _selectors,
        bool _whitelisted
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _selectors.length;
        for (uint256 i = 0; i < length; ++i) {
            _setFunctionWhitelist(_selectors[i], _whitelisted);
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isFunctionSelectorWhitelisted(
        bytes4 _selector
    ) external view returns (bool whitelisted) {
        return LibAllowList.selectorIsAllowed(_selector);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function getWhitelistedAddresses()
        external
        view
        returns (address[] memory addresses)
    {
        return LibAllowList.getAllowedContracts();
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isAddressWhitelisted(
        address _address
    ) external view returns (bool whitelisted) {
        return LibAllowList.contractIsAllowed(_address);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function getWhitelistedFunctionSelectors()
        external
        view
        returns (bytes4[] memory selectors)
    {
        return LibAllowList.getAllowedSelectors();
    }

    /// @dev Internal function to handle whitelist addition logic
    function _addToWhitelist(address _contractAddress) internal {
        if (_contractAddress == address(this)) {
            revert CannotAuthoriseSelf();
        }

        if (LibAllowList.contractIsAllowed(_contractAddress)) return;

        LibAllowList.addAllowedContract(_contractAddress);
        emit AddressWhitelisted(_contractAddress);
    }

    /// @dev Internal function to handle whitelist removal logic
    function _removeFromWhitelist(address _address) internal {
        if (!LibAllowList.contractIsAllowed(_address)) return;

        LibAllowList.removeAllowedContract(_address);
        emit AddressRemoved(_address);
    }

    /// @dev Internal function to handle function selector whitelist logic
    function _setFunctionWhitelist(
        bytes4 _selector,
        bool _whitelisted
    ) internal {
        bool currentlyWhitelisted = LibAllowList.selectorIsAllowed(_selector);

        if (_whitelisted != currentlyWhitelisted) {
            if (_whitelisted) {
                LibAllowList.addAllowedSelector(_selector);
            } else {
                LibAllowList.removeAllowedSelector(_selector);
            }
            emit FunctionSelectorWhitelistChanged(_selector, _whitelisted);
        }
    }

    /// Temporary methods for migration ///
    /// @dev Remove these methods after migration is complete in next facet upgrade.
    /// @inheritdoc IWhitelistManagerFacet
    function migrate(
        bytes4[] calldata _selectorsToRemove,
        address[] calldata _contractsToAdd,
        bytes4[] calldata _selectorsToAdd
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.AllowListStorage storage als = _getAllowListStorage();

        // return early if already migrated
        if (als.migrated) return;

        // clear old state
        // reset contractAllowList
        uint256 i;
        uint256 length = als.contracts.length;
        for (; i < length; ) {
            als.contractAllowList[als.contracts[i]] = false;
            unchecked {
                ++i;
            }
        }

        // reset selectorAllowList with external selectors array because new selectors array does not exist yet
        i = 0;
        length = _selectorsToRemove.length;
        for (; i < length; ) {
            als.selectorAllowList[_selectorsToRemove[i]] = false;
            unchecked {
                ++i;
            }
        }

        // reset contract array
        delete als.contracts;
        // clearing selectors (als.selectors) is not needed as it's a new variable

        // whitelist contracts
        i = 0;
        length = _contractsToAdd.length;
        for (; i < length; ) {
            if (_contractsToAdd[i] == address(this)) {
                revert CannotAuthoriseSelf();
            }

            // check for duplicate contracts in _contractsToAdd
            // this prevents both duplicates and ensures all contracts were properly reset
            if (LibAllowList.contractIsAllowed(_contractsToAdd[i])) {
                revert InvalidConfig();
            }

            LibAllowList.addAllowedContract(_contractsToAdd[i]);
            emit AddressWhitelisted(_contractsToAdd[i]);
            unchecked {
                ++i;
            }
        }

        // whitelist selectors
        i = 0;
        length = _selectorsToAdd.length;
        for (; i < length; ) {
            // check for duplicate selectors in _selectorsToAdd or selectors not present in _selectorsToRemove
            // this prevents both duplicates and ensures all selectors were properly reset
            if (LibAllowList.selectorIsAllowed(_selectorsToAdd[i])) {
                revert InvalidConfig();
            }

            LibAllowList.addAllowedSelector(_selectorsToAdd[i]);
            emit FunctionSelectorWhitelistChanged(_selectorsToAdd[i], true);
            unchecked {
                ++i;
            }
        }

        // Mark as migrated
        als.migrated = true;
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isMigrated() external view returns (bool) {
        LibAllowList.AllowListStorage storage als = _getAllowListStorage();
        return als.migrated;
    }

    /// @dev Fetch allow list storage struct
    function _getAllowListStorage()
        internal
        pure
        returns (LibAllowList.AllowListStorage storage als)
    {
        bytes32 position = LibAllowList.NAMESPACE;
        assembly {
            als.slot := position
        }
    }
}
