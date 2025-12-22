// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IWhitelistManagerFacet
/// @author LI.FI (https://li.fi)
/// @notice Interface for WhitelistManagerFacet facet for managing approved contracts and function selectors.
/// @dev This interface supports a dual-model allow list system:
///      1. NEW GRANULAR SYSTEM: Contract-selector pairs for precise control
///      2. BACKWARD COMPATIBILITY: Global lists for existing deployed facets
///      New development should exclusively use the granular functions.
/// @custom:version 1.1.0
interface IWhitelistManagerFacet {
    /// Events ///

    /// @notice Emitted when a contract and selector pair is whitelisted or unwhitelisted.
    event ContractSelectorWhitelistChanged(
        address indexed contractAddress,
        bytes4 indexed selector,
        bool indexed whitelisted
    );

    // ============================================================================
    // NEW GRANULAR SYSTEM FUNCTIONS
    // ============================================================================
    // These functions operate on contract-selector pairs and provide precise control.
    // They are the source of truth and synchronize the global arrays automatically.
    // ============================================================================

    /// @notice Sets the whitelist status for a specific contract and selector pair.
    /// @param _contract The contract address to whitelist or unwhitelist.
    /// @param _selector The function selector to whitelist or unwhitelist.
    /// @param _whitelisted Whether the contract and selector pair should be whitelisted.
    /// @dev APPROVE TO-ONLY SELECTOR: Use 0xffffffff to whitelist contracts that are used
    ///      only as approveTo in LibSwap.SwapData, without allowing function calls to them.
    ///      Some DEXs have specific contracts that need to be approved to while another
    ///      (router) contract must be called to initiate the swap. This selector enables
    ///      whitelisting such approveTo-only contracts while preventing any function calls.
    ///      Note: This makes isAddressWhitelisted(_contract) return true for backward
    ///      compatibility, but does not allow any granular calls. Actual selectors must
    ///      still be explicitly whitelisted for real function call usage.
    function setContractSelectorWhitelist(
        address _contract,
        bytes4 _selector,
        bool _whitelisted
    ) external;

    /// @notice Sets the whitelist status for multiple contract and selector pairs.
    /// @param _contracts Array of contract addresses to whitelist or unwhitelist.
    /// @param _selectors Array of function selectors to whitelist or unwhitelist.
    /// @param _whitelisted Whether the contract and selector pairs should be whitelisted.
    /// @dev APPROVE TO-ONLY SELECTOR: Use 0xffffffff to whitelist contracts that are used
    ///      only as approveTo in LibSwap.SwapData, without allowing function calls to them.
    ///      Some DEXs have specific contracts that need to be approved to while another
    ///      (router) contract must be called to initiate the swap. This selector enables
    ///      whitelisting such approveTo-only contracts while preventing any function calls.
    ///      Note: This makes isAddressWhitelisted(_contract) return true for backward
    ///      compatibility, but does not allow any granular calls. Actual selectors must
    ///      still be explicitly whitelisted for real function call usage.
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
}
