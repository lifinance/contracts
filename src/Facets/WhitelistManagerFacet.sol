// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { IWhitelistManagerFacet } from "../Interfaces/IWhitelistManagerFacet.sol";
import { CannotAuthoriseSelf } from "../Errors/GenericErrors.sol";

/// @title Whitelist Manager Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet contract for managing whitelisted addresses for various protocol interactions.
/// @custom:version 1.0.1
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

    /// @notice Adds or removes a specific function selector to/from the allowlist.
    /// @param _selector The function selector to allow or disallow.
    /// @param _approval Whether the function selector should be allowed.
    function setFunctionApprovalBySelector(
        bytes4 _selector,
        bool _approval
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _setFunctionApproval(_selector, _approval);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchSetFunctionApprovalBySelector(
        bytes4[] calldata _selectors,
        bool _approval
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _selectors.length;
        for (uint256 i = 0; i < length; ++i) {
            _setFunctionApproval(_selectors[i], _approval);
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isFunctionApproved(
        bytes4 _selector
    ) external view returns (bool approved) {
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
    ) external view returns (bool approved) {
        return LibAllowList.contractIsAllowed(_address);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function getApprovedFunctionSelectors()
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

    /// @dev Internal function to handle function selector approval logic
    function _setFunctionApproval(bytes4 _selector, bool _approval) internal {
        bool currentlyApproved = LibAllowList.selectorIsAllowed(_selector);

        if (_approval != currentlyApproved) {
            if (_approval) {
                LibAllowList.addAllowedSelector(_selector);
            } else {
                LibAllowList.removeAllowedSelector(_selector);
            }
            emit FunctionSelectorApprovalChanged(_selector, _approval);
        }
    }

    /// Temporary methods for migration ///
    /// @dev These methods should be removed after the migration is complete. On the next facet upgrade, this section should be removed.

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
        for (uint256 i = 0; i < als.contracts.length; i++) {
            address contractAddr = als.contracts[i];
            als.contractAllowList[contractAddr] = false;
        }

        // reset selectorAllowList with external selectors array because new selectors array does not exist yet
        for (uint256 i = 0; i < _selectorsToRemove.length; i++) {
            bytes4 selector = _selectorsToRemove[i];
            als.selectorAllowList[selector] = false;
        }

        // reset contract array
        delete als.contracts;
        // clearing selectors is not needed as it new variable

        // whitelist contracts
        for (uint256 i = 0; i < _contractsToAdd.length; i++) {
            LibAllowList.addAllowedContract(_contractsToAdd[i]);
        }

        // whitelist selectors
        for (uint256 i = 0; i < _selectorsToAdd.length; i++) {
            LibAllowList.addAllowedSelector(_selectorsToAdd[i]);
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
