// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { LibAccess } from "lifi/Libraries/LibAccess.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { CannotAuthoriseSelf, InvalidConfig } from "lifi/Errors/GenericErrors.sol";

/// @title MigrateWhitelistManager
/// @author LI.FI (https://li.fi)
/// @notice One-time migration contract for WhitelistManagerFacet
/// @dev This contract is meant to be called via delegatecall during diamondCut
contract MigrateWhitelistManager {
    /// Events ///

    event ContractSelectorWhitelistChanged(
        address indexed _contract,
        bytes4 indexed _selector,
        bool _whitelisted
    );

    /// External Methods ///

    /// @notice Performs one-time migration of whitelist data
    /// @dev Remove this method after migration is complete in next facet upgrade.
    /// @param _selectorsToRemove Array of function selectors to remove from old storage
    /// @param _contracts Array of contract addresses to whitelist
    /// @param _selectors 2D array of function selectors corresponding to each contract
    /// @param _grantAccessTo Address to grant access to batchSetContractSelectorWhitelist
    function migrate(
        bytes4[] calldata _selectorsToRemove,
        address[] calldata _contracts,
        bytes4[][] calldata _selectors,
        address _grantAccessTo
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
            delete als.contractAllowList[als.contracts[i]];
            unchecked {
                ++i;
            }
        }

        // reset selectorAllowList with external selectors array because new selectors array does not exist yet
        i = 0;
        length = _selectorsToRemove.length;
        for (; i < length; ) {
            delete als.selectorAllowList[_selectorsToRemove[i]];
            unchecked {
                ++i;
            }
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
            for (uint256 j = 0; j < contractSelectors.length; ) {
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
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++i;
            }
        }

        // Mark as migrated
        als.migrated = true;

        // Grant access to batchSetContractSelectorWhitelist if address provided
        if (_grantAccessTo != address(0)) {
            // Note: We need to use the selector from the actual facet, not this contract
            // The selector is: 0x63ebf099
            LibAccess.addAccess(
                0x63ebf099, // batchSetContractSelectorWhitelist selector
                _grantAccessTo
            );
        }
    }

    /// Internal Logic ///

    /// @dev Remove this method after migration is complete in next facet upgrade.
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
