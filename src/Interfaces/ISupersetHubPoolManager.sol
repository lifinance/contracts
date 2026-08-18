// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISupersetHubPoolManager
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for Superset's hub-chain entrypoints used by SupersetFacet
/// @dev Mirrors `HubPoolManager.exactInput` / `multiHopSwapWithOutputChain` from
///      Superset's virtual-pools contracts. The hub cross-chain flow has no
///      `refundAddress` or `options` because failures revert synchronously on the
///      hub itself and there's no source → hub LZ leg.
/// @custom:version 1.1.0
interface ISupersetHubPoolManager {
    /// @notice Uniswap-V3-style params for an atomic hub-chain multi-hop swap
    /// @dev `path` is packed `address(20) || fee(3) || address(20) || ...` over the
    ///      hub's *local* token addresses (not OmniToken IDs).
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Atomic same-chain swap on the hub (no LayerZero messaging)
    /// @param _params Uniswap-V3-style exact-input params
    /// @return amountOut Amount of the output token transferred to `_params.recipient`
    function exactInput(
        ExactInputParams calldata _params
    ) external payable returns (uint256 amountOut);

    /// @notice Initiate a cross-chain swap from the hub chain (Arbitrum) to a spoke
    /// @param _path Packed omniTokenId(32) || fee(3) || ... || omniTokenId(32)
    /// @param _amountIn Amount of the source omni-token pulled from msg.sender
    /// @param _amountOutMin Slippage floor on destination omni-token
    /// @param _recipient Address receiving `amountOut` on the destination spoke
    /// @param _fallbackEoA Pure EOA fall-through if delivery to `_recipient` fails
    /// @param _deadline Unix timestamp after which the hub rejects the request
    /// @param _toEid LayerZero endpoint ID of the destination spoke chain (must differ from hub EID)
    function multiHopSwapWithOutputChain(
        bytes calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        address _recipient,
        address _fallbackEoA,
        uint256 _deadline,
        uint32 _toEid
    ) external payable;
}
