// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IWhitelistManagerFacet
/// @author LI.FI (https://li.fi)
/// @notice Interface for WhitelistManagerFacet facet for managing approved contracts and function selectors.
/// @dev This interface supports a dual-model allow list system:
///      1. NEW GRANULAR SYSTEM: Contract-selector pairs for precise control
///      2. BACKWARD COMPATIBILITY: Global lists for existing deployed facets
///      New development should exclusively use the granular functions.
/// @custom:version 1.0.0
interface IWhitelistManagerFacet {
    /// Events ///

    /// @notice Emitted when a new address is added to the whitelist.
    event AddressWhitelisted(address indexed whitelistedAddress);

    /// @notice Emitted when a function selector is added to the whitelist.
    event FunctionSelectorWhitelistChanged(
        bytes4 indexed selector,
        bool indexed whitelisted
    );

    /// @notice Emitted when a contract and selector pair is whitelisted or unwhitelisted.
    event ContractSelectorWhitelistChanged(
        address indexed contractAddress,
        bytes4 indexed selector,
        bool indexed whitelisted
    );

    // ============================================================================
    // NEW GRANULAR SYSTEM FUNCTIONS (PREFERRED)
    // ============================================================================
    // These functions operate on contract-selector pairs and provide precise control.
    // They are the source of truth and synchronize the global arrays automatically.
    // ============================================================================

    /// @notice Sets the whitelist status for a specific contract and selector pair.
    /// @param _contract The contract address to whitelist or unwhitelist.
    /// @param _selector The function selector to whitelist or unwhitelist.
    /// @param _whitelisted Whether the contract and selector pair should be whitelisted.
    /// @dev MARKER SELECTOR: For backward compatibility with legacy address-only checks,
    ///      use 0xffffffff as an "empty/marker" selector when whitelisting a contract.
    ///      This makes isAddressWhitelisted(_contract) return true but does not allow any
    ///      granular calls. In the contract-selector system, actual selectors must still
    ///      be explicitly whitelisted for real usage.
    function setContractSelectorWhitelist(
        address _contract,
        bytes4 _selector,
        bool _whitelisted
    ) external;

    /// @notice Sets the whitelist status for multiple contract and selector pairs.
    /// @param _contracts Array of contract addresses to whitelist or unwhitelist.
    /// @param _selectors Array of function selectors to whitelist or unwhitelist.
    /// @param _whitelisted Whether the contract and selector pairs should be whitelisted.
    /// @dev MARKER SELECTOR: Use 0xffffffff as an "empty/marker" selector to mark an
    ///      address as whitelisted for legacy address-only checks. It is not usable for
    ///      granular calls—explicit function selectors are still required.
    function batchSetContractSelectorWhitelist(
        address[] calldata _contracts,
        bytes4[] calldata _selectors,
        bool _whitelisted
    ) external;

    /// @notice Returns whether a specific contract and selector pair is whitelisted.
    /// @param _contract The contract address to query.
    /// @param _selector The function selector to query.
    /// @return whitelisted Whether the pair is whitelisted.
    function isContractSelectorWhitelisted(
        address _contract,
        bytes4 _selector
    ) external view returns (bool whitelisted);

    /// @notice Returns a list of whitelisted selectors for a specific contract.
    /// @param _contract The contract address to query.
    /// @return selectors List of whitelisted selectors for the contract.
    function getWhitelistedSelectorsForContract(
        address _contract
    ) external view returns (bytes4[] memory selectors);

    /// @notice Returns all whitelisted contract-selector pairs in a single call.
    /// @dev This is more efficient than calling getWhitelistedAddresses() and then
    ///      getWhitelistedSelectorsForContract() for each address separately.
    /// @return contracts Array of whitelisted contract addresses.
    /// @return selectors Array of corresponding selector arrays for each contract.
    function getAllContractSelectorPairs()
        external
        view
        returns (address[] memory contracts, bytes4[][] memory selectors);

    /// @notice Check if the allow list has been migrated.
    /// @return True if the allow list has been migrated, false otherwise.
    function isMigrated() external view returns (bool);

    // ============================================================================
    // BACKWARD COMPATIBILITY FUNCTIONS
    // ============================================================================
    // These functions read from the global arrays. They are required for existing,
    // deployed facets to continue functioning. They should be considered part of a
    // transitional phase and MUST NOT be used in new development.
    // ============================================================================

    /// @notice [BACKWARD COMPATIBILITY] Returns a list of all whitelisted addresses.
    /// @dev WARNING: This function reads from the global list and is NOT granular.
    ///      It is required for older, deployed facets to function correctly.
    ///      Avoid use in new code. Use isContractSelectorWhitelisted() instead.
    ///      Reading ~10 000 entries is safe, but if the list grows toward ~45 000+,
    ///      the call may run out of gas. Do not rely on it for unbounded iteration.
    /// @return addresses List of whitelisted addresses.
    function getWhitelistedAddresses()
        external
        view
        returns (address[] memory addresses);

    /// @notice [BACKWARD COMPATIBILITY] Returns whether an address is whitelisted.
    /// @dev WARNING: This function reads from the global list and is NOT granular.
    ///      It is required for older, deployed facets to function correctly.
    ///      Avoid use in new code. Use isContractSelectorWhitelisted() instead.
    /// @param _address The address to query.
    /// @return whitelisted Whitelisted or not.
    function isAddressWhitelisted(
        address _address
    ) external view returns (bool whitelisted);

    /// @notice [BACKWARD COMPATIBILITY] Returns a list of all approved function selectors.
    /// @dev WARNING: This function reads from the global list and is NOT granular.
    ///      It is required for older, deployed facets to function correctly.
    ///      Avoid use in new code. Use isContractSelectorWhitelisted() instead.
    ///      Reading ~10 000 entries is safe, but if the list grows toward ~45 000+,
    ///      the call may run out of gas. Do not rely on it for unbounded iteration.
    /// @return selectors List of approved function selectors.
    function getWhitelistedFunctionSelectors()
        external
        view
        returns (bytes4[] memory selectors);

    /// @notice [BACKWARD COMPATIBILITY] Returns whether a function selector is whitelisted.
    /// @dev WARNING: This function reads from the global list and is NOT granular.
    ///      It is required for older, deployed facets to function correctly.
    ///      Avoid use in new code. Use isContractSelectorWhitelisted() instead.
    /// @param _selector The function selector to query.
    /// @return whitelisted Whitelisted or not.
    function isFunctionSelectorWhitelisted(
        bytes4 _selector
    ) external view returns (bool whitelisted);

    /// Temporary methods for migration ///

    /// @notice Temporary method to check if the allow list has been migrated.
    /// @dev Remove these methods after migration is complete in next facet upgrade.
    /// @dev This function can only be called by the diamond owner or authorized addresses.
    /// @param _selectorsToRemove Array of selectors to remove from the allow list.
    /// @param _contracts Array of contract addresses.
    /// @param _selectors Parallel array of selector arrays for each contract.
    function migrate(
        bytes4[] calldata _selectorsToRemove,
        address[] calldata _contracts,
        bytes4[][] calldata _selectors
    ) external;
}
