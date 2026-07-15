// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IOnchainSwapV3
/// @notice Interface for the Symbiosis OnchainSwapV3 router used for swaps from
///         syBTC-connector chains to Bitcoin (bypasses the Symbiosis MetaRouter).
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IOnchainSwapV3 {
    /// @notice Accepts the user's funds, optionally swaps them to syBTC via `dex`,
    ///         and burns syBTC to release BTC on the Bitcoin chain.
    /// @param token The input token (address(0) for the native asset).
    /// @param amount The input amount.
    /// @param dex The DEX router used for the optional input-token -> syBTC swap.
    /// @param dexgateway The spender the DEX is approved through for that swap.
    /// @param calldata_ The Symbiosis-provided calldata for the inner swap/burn.
    function onswap(
        address token,
        uint256 amount,
        address dex,
        address dexgateway,
        bytes calldata calldata_
    ) external payable;
}
