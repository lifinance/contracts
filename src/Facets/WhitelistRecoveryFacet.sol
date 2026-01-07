// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title WhitelistRecoveryFacet
/// @author LI.FI (https://li.fi)
/// @notice Emergency recovery facet to clear corrupted LibAllowList storage state
/// @dev This facet provides emergency functions to reset LibAllowList storage when state corruption occurs.
/// @dev WARNING: This facet should only be used in emergency situations and removed after recovery.
/// @custom:version 1.0.2
contract WhitelistRecoveryFacet {
    /// Storage ///
    /// @dev Uses the same storage namespace as LibAllowList to access its storage
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.library.allow.list");

    struct AllowListStorage {
        // V1 Storage
        mapping(address => bool) contractAllowList;
        mapping(bytes4 => bool) selectorAllowList;
        address[] contracts;
        // V2 Storage
        mapping(address => uint256) contractToIndex;
        mapping(bytes4 => uint256) selectorToIndex;
        bytes4[] selectors;
        mapping(address => mapping(bytes4 => bool)) contractSelectorAllowList;
        mapping(bytes4 => uint256) selectorReferenceCount;
        mapping(address => bytes4[]) whitelistedSelectorsByContract;
        mapping(address => mapping(bytes4 => uint256)) selectorIndices;
        bool migrated;
    }

    /// Events ///
    /// @notice Emitted when storage is cleared
    event WhitelistStorageCleared(address indexed caller);

    /// @notice Emitted when arrays are cleared
    event WhitelistArraysCleared(address indexed caller);

    /// @notice Emitted when migrated flag is reset
    event MigratedFlagReset(address indexed caller);

    /// External Methods ///
    /// @notice Clears all arrays in LibAllowList storage (contracts[] and selectors[])
    /// @dev This function clears the arrays but leaves mappings intact (mappings cannot be iterated).
    /// @dev Mappings will become stale but won't affect functionality if arrays are empty.
    /// @dev Can only be called by contract owner or authorized addresses.
    function clearWhitelistArrays() external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        AllowListStorage storage als = _getStorage();

        // Clear contracts array by popping all elements
        uint256 contractsLength = als.contracts.length;
        for (uint256 i = 0; i < contractsLength; ) {
            als.contracts.pop();
            unchecked {
                ++i;
            }
        }

        // Clear selectors array by popping all elements
        uint256 selectorsLength = als.selectors.length;
        for (uint256 i = 0; i < selectorsLength; ) {
            als.selectors.pop();
            unchecked {
                ++i;
            }
        }

        emit WhitelistArraysCleared(msg.sender);
    }

    /// @notice Resets the migrated flag in LibAllowList storage
    /// @dev Can only be called by contract owner or authorized addresses.
    function resetMigratedFlag() external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        AllowListStorage storage als = _getStorage();
        als.migrated = false;

        emit MigratedFlagReset(msg.sender);
    }

    /// @notice Clears ALL mappings and arrays in LibAllowList storage (full reset)
    /// @dev This function iterates through arrays to delete mapping keys, then clears arrays.
    /// @dev This is the most comprehensive recovery function.
    /// @dev Can only be called by contract owner or authorized addresses.
    /// @dev NOTE: This version does not clear orphaned entries. Use the overloaded version with parameters for complete cleanup.
    function fullWhitelistStorageReset() external {
        fullWhitelistStorageReset(new address[](0), new bytes4[][](0));
    }

    /// @notice Clears ALL mappings and arrays in LibAllowList storage (full reset)
    /// @dev This function iterates through arrays to delete mapping keys, then clears arrays.
    /// @dev Additionally clears orphaned entries from contractSelectorAllowList using provided contracts/selectors.
    /// @dev This is the most comprehensive recovery function.
    /// @param _additionalContracts Array of contract addresses from whitelist config files to check for orphaned entries.
    /// @param _additionalSelectors Array of selector arrays, where _additionalSelectors[i] contains selectors for _additionalContracts[i].
    /// @dev _additionalContracts.length must equal _additionalSelectors.length.
    /// @dev Can only be called by contract owner or authorized addresses.
    function fullWhitelistStorageReset(
        address[] memory _additionalContracts,
        bytes4[][] memory _additionalSelectors
    ) public {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        if (_additionalContracts.length != _additionalSelectors.length) {
            revert InvalidConfig();
        }

        AllowListStorage storage als = _getStorage();

        // Step 1: Clear all mappings using keys from arrays
        // First, get all contracts and selectors before clearing arrays
        address[] memory contractsToClear = new address[](
            als.contracts.length
        );
        bytes4[] memory selectorsToClear = new bytes4[](als.selectors.length);

        for (uint256 i = 0; i < als.contracts.length; ) {
            contractsToClear[i] = als.contracts[i];
            unchecked {
                ++i;
            }
        }

        for (uint256 i = 0; i < als.selectors.length; ) {
            selectorsToClear[i] = als.selectors[i];
            unchecked {
                ++i;
            }
        }

        // Step 2: Delete all contract mappings
        for (uint256 i = 0; i < contractsToClear.length; ) {
            address contractAddr = contractsToClear[i];

            // Delete V1 mappings
            delete als.contractAllowList[contractAddr];
            delete als.contractToIndex[contractAddr];

            // Delete V2 nested mappings for this contract
            bytes4[] memory contractSelectors = als
                .whitelistedSelectorsByContract[contractAddr];
            for (uint256 j = 0; j < contractSelectors.length; ) {
                bytes4 selector = contractSelectors[j];
                delete als.contractSelectorAllowList[contractAddr][selector];
                delete als.selectorIndices[contractAddr][selector];
                unchecked {
                    ++j;
                }
            }

            // Clear the contract's selector array
            uint256 contractSelectorsLength = als
                .whitelistedSelectorsByContract[contractAddr]
                .length;
            for (uint256 j = 0; j < contractSelectorsLength; ) {
                als.whitelistedSelectorsByContract[contractAddr].pop();
                unchecked {
                    ++j;
                }
            }

            unchecked {
                ++i;
            }
        }

        // Step 3: Delete all selector mappings
        for (uint256 i = 0; i < selectorsToClear.length; ) {
            bytes4 selector = selectorsToClear[i];

            // Delete V1 mappings
            delete als.selectorAllowList[selector];
            delete als.selectorToIndex[selector];
            delete als.selectorReferenceCount[selector];

            unchecked {
                ++i;
            }
        }

        // Step 4: Clear orphaned entries from contractSelectorAllowList using provided contracts/selectors
        // This handles cases where entries exist in the mapping but not in the arrays
        for (uint256 i = 0; i < _additionalContracts.length; ) {
            address contractAddr = _additionalContracts[i];
            bytes4[] memory selectors = _additionalSelectors[i];

            // First, clear any entries that might still be in whitelistedSelectorsByContract
            // (handles contracts not in als.contracts[] array)
            bytes4[] memory existingSelectors = als
                .whitelistedSelectorsByContract[contractAddr];
            for (uint256 k = 0; k < existingSelectors.length; ) {
                bytes4 existingSelector = existingSelectors[k];
                delete als.contractSelectorAllowList[contractAddr][
                    existingSelector
                ];
                delete als.selectorIndices[contractAddr][existingSelector];
                unchecked {
                    ++k;
                }
            }

            // Clear the whitelistedSelectorsByContract array for this contract
            uint256 existingSelectorsLength = als
                .whitelistedSelectorsByContract[contractAddr]
                .length;
            for (uint256 k = 0; k < existingSelectorsLength; ) {
                als.whitelistedSelectorsByContract[contractAddr].pop();
                unchecked {
                    ++k;
                }
            }

            // Then, clear entries explicitly passed in _additionalSelectors
            // (handles orphaned entries not in any array)
            for (uint256 j = 0; j < selectors.length; ) {
                bytes4 selector = selectors[j];
                // Only delete if entry exists (idempotent - safe to call even if already deleted)
                if (als.contractSelectorAllowList[contractAddr][selector]) {
                    delete als.contractSelectorAllowList[contractAddr][
                        selector
                    ];
                    delete als.selectorIndices[contractAddr][selector];
                }
                unchecked {
                    ++j;
                }
            }

            // Also clear V1 mappings for this contract if not already cleared
            delete als.contractAllowList[contractAddr];
            delete als.contractToIndex[contractAddr];

            unchecked {
                ++i;
            }
        }

        // Step 5: Clear arrays
        uint256 contractsLength = als.contracts.length;
        for (uint256 i = 0; i < contractsLength; ) {
            als.contracts.pop();
            unchecked {
                ++i;
            }
        }

        uint256 selectorsLength = als.selectors.length;
        for (uint256 i = 0; i < selectorsLength; ) {
            als.selectors.pop();
            unchecked {
                ++i;
            }
        }

        // Step 6: Reset migrated flag
        als.migrated = false;

        emit WhitelistStorageCleared(msg.sender);
    }

    /// @notice Clears orphaned entries for a batch of contracts (gas-efficient version)
    /// @param _contracts Array of contract addresses to process
    /// @param _selectors Array of selector arrays, where _selectors[i] contains selectors for _contracts[i]
    /// @dev This function only processes Step 4 (orphaned entries) for the provided contracts
    /// @dev Call this function multiple times with different batches to process all contracts
    /// @dev Should be called after fullWhitelistStorageReset() with empty arrays to clear main storage
    /// @dev Can only be called by contract owner or authorized addresses.
    function fullWhitelistStorageResetBatch(
        address[] memory _contracts,
        bytes4[][] memory _selectors
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        if (_contracts.length != _selectors.length) {
            revert InvalidConfig();
        }

        AllowListStorage storage als = _getStorage();

        // Process Step 4: Clear orphaned entries from contractSelectorAllowList using provided contracts/selectors
        // This handles cases where entries exist in the mapping but not in the arrays
        for (uint256 i = 0; i < _contracts.length; ) {
            address contractAddr = _contracts[i];
            bytes4[] memory selectors = _selectors[i];

            // First, clear any entries that might still be in whitelistedSelectorsByContract
            // (handles contracts not in als.contracts[] array)
            bytes4[] memory existingSelectors = als
                .whitelistedSelectorsByContract[contractAddr];
            for (uint256 k = 0; k < existingSelectors.length; ) {
                bytes4 existingSelector = existingSelectors[k];
                delete als.contractSelectorAllowList[contractAddr][
                    existingSelector
                ];
                delete als.selectorIndices[contractAddr][existingSelector];
                unchecked {
                    ++k;
                }
            }

            // Clear the whitelistedSelectorsByContract array for this contract
            uint256 existingSelectorsLength = als
                .whitelistedSelectorsByContract[contractAddr]
                .length;
            for (uint256 k = 0; k < existingSelectorsLength; ) {
                als.whitelistedSelectorsByContract[contractAddr].pop();
                unchecked {
                    ++k;
                }
            }

            // Then, clear entries explicitly passed in _selectors
            // (handles orphaned entries not in any array)
            for (uint256 j = 0; j < selectors.length; ) {
                bytes4 selector = selectors[j];
                // Only delete if entry exists (idempotent - safe to call even if already deleted)
                if (als.contractSelectorAllowList[contractAddr][selector]) {
                    delete als.contractSelectorAllowList[contractAddr][
                        selector
                    ];
                    delete als.selectorIndices[contractAddr][selector];
                }
                unchecked {
                    ++j;
                }
            }

            // Also clear V1 mappings for this contract if not already cleared
            delete als.contractAllowList[contractAddr];
            delete als.contractToIndex[contractAddr];

            unchecked {
                ++i;
            }
        }

        emit WhitelistStorageCleared(msg.sender);
    }

    /// @notice Clears selectors array and nested mappings for a specific contract
    /// @dev This can be used to fix corrupted whitelistedSelectorsByContract arrays.
    /// @dev Also clears all nested mappings (contractSelectorAllowList and selectorIndices) for this contract.
    /// @param _contract The contract address whose selectors array should be cleared.
    /// @dev Can only be called by contract owner or authorized addresses.
    function clearContractSelectorsArray(address _contract) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        if (_contract == address(0)) revert InvalidConfig();

        AllowListStorage storage als = _getStorage();

        // Get selectors before clearing
        bytes4[] memory selectorsToClear = new bytes4[](
            als.whitelistedSelectorsByContract[_contract].length
        );
        for (uint256 i = 0; i < selectorsToClear.length; ) {
            selectorsToClear[i] = als.whitelistedSelectorsByContract[
                _contract
            ][i];
            unchecked {
                ++i;
            }
        }

        // Delete nested mappings for each selector
        for (uint256 i = 0; i < selectorsToClear.length; ) {
            bytes4 selector = selectorsToClear[i];
            delete als.contractSelectorAllowList[_contract][selector];
            delete als.selectorIndices[_contract][selector];
            unchecked {
                ++i;
            }
        }

        // Clear whitelistedSelectorsByContract array for this contract
        uint256 selectorsLength = als
            .whitelistedSelectorsByContract[_contract]
            .length;
        for (uint256 i = 0; i < selectorsLength; ) {
            als.whitelistedSelectorsByContract[_contract].pop();
            unchecked {
                ++i;
            }
        }

        emit WhitelistArraysCleared(msg.sender);
    }

    /// Internal Methods ///
    /// @dev Fetches the storage pointer for LibAllowList using the same namespace.
    /// @return als The storage pointer.
    function _getStorage()
        internal
        pure
        returns (AllowListStorage storage als)
    {
        bytes32 position = NAMESPACE;
        assembly {
            als.slot := position
        }
    }
}
