// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for SyncSwapV2 Vault
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
/// @notice This interface is used to interact with the SyncSwapV2 Vault
interface ISyncSwapV2Pool {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    /// @dev Swaps between tokens.
    function swap(
        bytes calldata data,
        address sender,
        address callback,
        bytes calldata callbackData
    ) external returns (TokenAmount memory tokenAmount);
}
