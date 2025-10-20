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
contract WhitelistManagerFacet is IWhitelistManagerFacet {
    /// External Methods ///

    /// @inheritdoc IWhitelistManagerFacet
    function setContractSelectorWhitelist(
        address _contract,
        bytes4 _selector,
        bool _whitelisted
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _setContractSelectorWhitelist(_contract, _selector, _whitelisted);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchSetContractSelectorWhitelist(
        address[] calldata _contracts,
        bytes4[] calldata _selectors,
        bool _whitelisted
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        if (_contracts.length != _selectors.length) {
            revert InvalidConfig();
        }
        for (uint256 i = 0; i < _contracts.length; ++i) {
            _setContractSelectorWhitelist(
                _contracts[i],
                _selectors[i],
                _whitelisted
            );
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isContractSelectorWhitelisted(
        address _contract,
        bytes4 _selector
    ) external view returns (bool whitelisted) {
        return LibAllowList.contractSelectorIsAllowed(_contract, _selector);
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

    /// @inheritdoc IWhitelistManagerFacet
    function getWhitelistedSelectorsForContract(
        address _contract
    ) external view returns (bytes4[] memory selectors) {
        return LibAllowList.getWhitelistedSelectorsForContract(_contract);
    }

    /// Internal Logic ///

    /// @dev The single internal function that all state changes must flow through.
    function _setContractSelectorWhitelist(
        address _contract,
        bytes4 _selector,
        bool _whitelisted
    ) internal {
        if (_contract == address(this)) {
            revert CannotAuthoriseSelf();
        }
        // Check current status to prevent redundant operations and emitting unnecessary events.
        bool isCurrentlyWhitelisted = LibAllowList.contractSelectorIsAllowed(
            _contract,
            _selector
        );
        if (isCurrentlyWhitelisted == _whitelisted) {
            return;
        }

        if (_whitelisted) {
            LibAllowList.addAllowedContractSelector(_contract, _selector);
        } else {
            LibAllowList.removeAllowedContractSelector(_contract, _selector);
        }
        emit ContractSelectorWhitelistChanged(
            _contract,
            _selector,
            _whitelisted
        );
    }

    /// Temporary methods for migration ///
    /// @dev Remove these methods after migration is complete in next facet upgrade.
    /// @inheritdoc IWhitelistManagerFacet
    function migrate(
        bytes4[] calldata _selectorsToRemove,
        address[] calldata _contracts,
        bytes4[][] calldata _selectors
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.AllowListStorage storage als = _getAllowListStorage();

        // return early if already migrated
        if (als.migrated) return;

        // Validate input arrays have matching lengths
        if (_contracts.length != _selectors.length) {
            revert InvalidConfig();
        }

        // clear old state
        // reset contractAllowList
        uint256 i;
        uint256 length = als.contracts.length;
        for (; i < length; ) {
            als.contractAllowList[als.contracts[i]] = false;
            ++i;
        }

        // reset selectorAllowList with external selectors array because new selectors array does not exist yet
        i = 0;
        length = _selectorsToRemove.length;
        for (; i < length; ) {
            als.selectorAllowList[_selectorsToRemove[i]] = false;
            ++i;
        }

        // reset contract array
        delete als.contracts;
        // clearing selectors (als.selectors) is not needed as it's a new variable

        // whitelist contract-selector pairs
        i = 0;
        length = _contracts.length;
        for (; i < length; ) {
            address contractAddr = _contracts[i];
            bytes4[] calldata contractSelectors = _selectors[i];

            if (contractAddr == address(this)) {
                revert CannotAuthoriseSelf();
            }

            // whitelist each selector for this contract
            for (uint256 j = 0; j < contractSelectors.length; ++j) {
                bytes4 selector = contractSelectors[j];

                // check for duplicate contract-selector pairs
                if (
                    LibAllowList.contractSelectorIsAllowed(
                        contractAddr,
                        selector
                    )
                ) {
                    revert InvalidConfig();
                }

                LibAllowList.addAllowedContractSelector(
                    contractAddr,
                    selector
                );
                emit ContractSelectorWhitelistChanged(
                    contractAddr,
                    selector,
                    true
                );
            }
            ++i;
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
