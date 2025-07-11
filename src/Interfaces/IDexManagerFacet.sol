// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IDexManagerFacet Interface
/// @notice Interface for the DexManagerFacet
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
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
