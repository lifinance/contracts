// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Dex Manager Facet Interface
/// @author LI.FI (https://li.fi)
/// @notice Interface for DexManagerFacet facet for managing approved DEXs.
/// @custom:version 1.0.0
interface IDexManagerFacet {
    /// @notice Emitted when a new DEX is approved.
    event DexAdded(address indexed dexAddress);

    /// @notice Emitted when an approved DEX is removed.
    event DexRemoved(address indexed dexAddress);

    /// @notice Emitted when a function signature approval is changed.
    event FunctionSignatureApprovalChanged(
        bytes4 indexed functionSignature,
        bool indexed approved
    );

    /// @notice Register the address of a DEX contract to be approved for swapping.
    /// @param _dex The address of the DEX contract to be approved.
    function addDex(address _dex) external;

    /// @notice Batch register the addresses of DEX contracts to be approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be approved.
    function batchAddDex(address[] calldata _dexs) external;

    /// @notice Unregister the address of a DEX contract approved for swapping.
    /// @param _dex The address of the DEX contract to be unregistered.
    function removeDex(address _dex) external;

    /// @notice Batch unregister the addresses of DEX contracts approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be unregistered.
    function batchRemoveDex(address[] calldata _dexs) external;

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

    /// @notice Returns a list of all approved DEX addresses.
    /// @return addresses List of approved DEX addresses.
    function approvedDexs() external view returns (address[] memory addresses);

    /// @notice Returns whether a contract address is approved.
    /// @param _contract The contract address to query.
    /// @return approved Approved or not.
    function isContractApproved(
        address _contract
    ) external view returns (bool approved);
}
