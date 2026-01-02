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
/// @custom:version 1.1.0
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
        for (uint256 i = 0; i < _contracts.length; ) {
            _setContractSelectorWhitelist(
                _contracts[i],
                _selectors[i],
                _whitelisted
            );
            unchecked {
                ++i;
            }
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
    function getWhitelistedSelectorsForContract(
        address _contract
    ) external view returns (bytes4[] memory selectors) {
        return LibAllowList.getWhitelistedSelectorsForContract(_contract);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function getAllContractSelectorPairs()
        external
        view
        returns (address[] memory contracts, bytes4[][] memory selectors)
    {
        // Get all whitelisted contracts
        contracts = LibAllowList.getAllowedContracts();

        // Initialize selectors array with same length as contracts
        selectors = new bytes4[][](contracts.length);

        // For each contract, get its whitelisted selectors
        for (uint256 i = 0; i < contracts.length; ) {
            selectors[i] = LibAllowList.getWhitelistedSelectorsForContract(
                contracts[i]
            );
            unchecked {
                ++i;
            }
        }
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
}
