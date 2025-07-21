// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IDexManagerFacet Interface
/// @notice Interface for the DexManagerFacet
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @dev DEPRECATED: This facet is being migrated to WhitelistManagerFacet for several reasons:
/// 1. The name "DexManager" was too specific as we whitelist various protocols, not just DEXes
/// 2. Shared the old LibAllowList storage layout which needed updating
/// 3. Function naming was inconsistent (e.g., "approved" vs "whitelist")
/// 4. Could not retrieve all whitelisted function selectors, leading to scattered offchain data management
/// Use WhitelistManagerFacet for all new implementations as it provides a more comprehensive
/// and accurately named interface with complete onchain selector storage.
interface IDexManagerFacet {
    function addDex(address _dex) external;
    function batchAddDex(address[] calldata _dexs) external;
    function removeDex(address _dex) external;
    function batchRemoveDex(address[] calldata _dexs) external;
    function setFunctionApprovalBySignature(
        bytes4 _signature,
        bool _approval
    ) external;
    function batchSetFunctionApprovalBySignature(
        bytes4[] calldata _signatures,
        bool _approval
    ) external;
    function isFunctionApproved(
        bytes4 _signature
    ) external view returns (bool approved);
    function approvedDexs() external view returns (address[] memory addresses);
}
