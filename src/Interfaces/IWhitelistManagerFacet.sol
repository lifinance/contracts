// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Whitelist Manager Facet Interface
/// @author LI.FI (https://li.fi)
/// @notice Interface for WhitelistManagerFacet facet for managing approved contracts and function selectors.
/// @custom:version 1.0.0
interface IWhitelistManagerFacet {
    /// @notice Emitted when a new address is added to the whitelist.
    event AddressWhitelisted(address indexed whitelistedAddress);

    /// @notice Emitted when an address is removed from the whitelist.
    event AddressRemoved(address indexed removedAddress);

    /// @notice Emitted when a function selector approval is changed.
    event FunctionSelectorApprovalChanged(
        bytes4 indexed functionSelector,
        bool indexed approved
    );

    /// @notice Register an address to be approved for interactions.
    /// @param _contractAddress The contract address to be whitelisted.
    function addToWhitelist(address _contractAddress) external;

    /// @notice Batch register addresses to be approved for interactions.
    /// @param _addresses The addresses to be whitelisted.
    function batchAddToWhitelist(address[] calldata _addresses) external;

    /// @notice Unregister an address from the whitelist.
    /// @param _address The address to be removed from the whitelist.
    function removeFromWhitelist(address _address) external;

    /// @notice Batch unregister addresses from the whitelist.
    /// @param _addresses The addresses to be removed from the whitelist.
    function batchRemoveFromWhitelist(address[] calldata _addresses) external;

    /// @notice Adds or removes a specific function selector to/from the allowlist.
    /// @param _selector The function selector to allow or disallow.
    /// @param _approval Whether the function selector should be allowed.
    function setFunctionApprovalBySelector(
        bytes4 _selector,
        bool _approval
    ) external;

    /// @notice Batch adds or removes specific function selectors to/from the allowlist.
    /// @param _selectors The function selectors to allow or disallow.
    /// @param _approval Whether the function selectors should be allowed.
    function batchSetFunctionApprovalBySelector(
        bytes4[] calldata _selectors,
        bool _approval
    ) external;

    /// @notice Returns whether a function selector is approved.
    /// @param _selector The function selector to query.
    /// @return approved Approved or not.
    function isFunctionApproved(
        bytes4 _selector
    ) external view returns (bool approved);

    /// @notice Returns a list of all whitelisted addresses.
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
    /// @return approved Whitelisted or not.
    function isAddressWhitelisted(
        address _address
    ) external view returns (bool approved);

    /// @notice Returns a list of all approved function selectors.
    /// @dev WARNING: this does a full read of stored selectors.
    ///      Reading ~10 000 entries is safe, but if the list grows toward ~45 000+,
    ///      the call may run out of gas. Do not rely on it for unbounded iteration.
    /// @return selectors List of approved function selectors.
    function getApprovedFunctionSelectors()
        external
        view
        returns (bytes4[] memory selectors);
}
