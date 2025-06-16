// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for SyncSwapV2 Vault
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @notice This interface is used to interact with the SyncSwapV2 Vault
interface ISyncSwapV2Vault {
    /// @notice Deposit tokens into the vault
    function deposit(
        address token,
        address to
    ) external payable returns (uint256 amount);
}
