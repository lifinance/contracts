// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IWhitelistManagerFacet
/// @author LI.FI (https://li.fi)
/// @notice Interface for WhitelistManagerFacet facet for managing approved contracts and function selectors.
/// @custom:version 1.0.0
interface IWhitelistManagerFacet {
    /// Events ///

    /// @notice Emitted when a new address is added to the whitelist.
    event AddressWhitelisted(address indexed whitelistedAddress);

    /// @notice Emitted when a function selector is added to the whitelist.
    event FunctionSelectorWhitelistChanged(bytes4 indexed selector, bool indexed whitelisted);

    /// @notice Emitted when a contract and selector pair is whitelisted or unwhitelisted.
    event ContractSelectorWhitelistChanged(
        address indexed contractAddress,
        bytes4 indexed selector,
        bool indexed whitelisted
    );

    /// @notice Sets the whitelist status for a specific contract and selector pair.
    /// @param _contract The contract address to whitelist or unwhitelist.
    /// @param _selector The function selector to whitelist or unwhitelist.
    /// @param _whitelisted Whether the contract and selector pair should be whitelisted.
    /// @dev TODO write about 0xDEADDEAD selector for contract used for approveTo
    function setContractSelectorWhitelist(
        address _contract,
        bytes4 _selector,
        bool _whitelisted
    ) external;

    /// @notice LEGACY: Returns a list of all whitelisted addresses. 
    /// @dev WARNING: this does a full read of stored addresses.
    ///      Reading ~10 000 entries is safe, but if the list grows toward ~45 000+,
    ///      the call may run out of gas. Do not rely on it for unbounded iteration.
    /// @return addresses List of whitelisted addresses.
    function getWhitelistedAddresses()
        external
        view
        returns (address[] memory addresses);

    /// @notice Returns whether an address is whitelisted.
    /// @param _address The address to query.
    /// @return whitelisted Whitelisted or not.
    function isAddressWhitelisted(
        address _address
    ) external view returns (bool whitelisted);

    /// @notice Returns a list of all approved function selectors.
    /// @dev WARNING: this does a full read of stored selectors.
    ///      Reading ~10 000 entries is safe, but if the list grows toward ~45 000+,
    ///      the call may run out of gas. Do not rely on it for unbounded iteration.
    /// @return selectors List of approved function selectors.
    function getWhitelistedFunctionSelectors()
        external
        view
        returns (bytes4[] memory selectors);

    /// @notice Migrate the allow list configuration with new contracts and selectors.
    /// @dev This function can only be called by the diamond owner or authorized addresses.
    /// @param _selectorsToRemove Array of selectors to remove from the allow list.
    /// @param _contractsToAdd Array of contract addresses to add to the allow list.
    /// @param _selectorsToAdd Array of selectors to add to the allow list.
    function migrate(
        bytes4[] calldata _selectorsToRemove,
        address[] calldata _contractsToAdd,
        bytes4[] calldata _selectorsToAdd
    ) external;

    /// @notice Check if the allow list has been migrated.
    /// @return True if the allow list has been migrated, false otherwise.
    function isMigrated() external view returns (bool);

    /// @notice Returns whether a function selector is whitelisted.
    /// @param _selector The function selector to query.
    /// @return whitelisted Whitelisted or not.
    function isFunctionSelectorWhitelisted(
        bytes4 _selector
    ) external view returns (bool whitelisted);
}
