// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Whitelist Manager Facet Interface
/// @author LI.FI (https://li.fi)
/// @notice Interface for WhitelistManagerFacet facet for managing approved contracts and addresses.
/// @custom:version 1.0.0
interface IWhitelistManagerFacet {
    /// @notice Emitted when a new address is added to the whitelist.
    event AddressWhitelisted(address indexed whitelistedAddress);

    /// @notice Emitted when an address is removed from the whitelist.
    event AddressRemoved(address indexed removedAddress);

    /// @notice Emitted when a function signature approval is changed.
    event FunctionSignatureApprovalChanged(
        bytes4 indexed functionSignature,
        bool indexed approved
    );

    /// @notice Register an address to be approved for interactions.
    /// @param _address The address to be whitelisted.
    function addToWhitelist(address _address) external;

    /// @notice Batch register addresses to be approved for interactions.
    /// @param _addresses The addresses to be whitelisted.
    function batchAddToWhitelist(address[] calldata _addresses) external;

    /// @notice Unregister an address from the whitelist.
    /// @param _address The address to be removed from the whitelist.
    function removeFromWhitelist(address _address) external;

    /// @notice Batch unregister addresses from the whitelist.
    /// @param _addresses The addresses to be removed from the whitelist.
    function batchRemoveFromWhitelist(address[] calldata _addresses) external;

    /// @notice Adds or removes a specific function signature to/from the allowlist.
    /// @param _signature The function signature to allow or disallow.
    /// @param _approval Whether the function signature should be allowed.
    function setFunctionApprovalBySignature(
        bytes4 _signature,
        bool _approval
    ) external;

    /// @notice Batch adds or removes specific function signatures to/from the allowlist.
    /// @param _signatures The function signatures to allow or disallow.
    /// @param _approval Whether the function signatures should be allowed.
    function batchSetFunctionApprovalBySignature(
        bytes4[] calldata _signatures,
        bool _approval
    ) external;

    /// @notice Returns whether a function signature is approved.
    /// @param _signature The function signature to query.
    /// @return approved Approved or not.
    function isFunctionApproved(
        bytes4 _signature
    ) external view returns (bool approved);

    /// @notice Returns a list of all whitelisted addresses.
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
}
