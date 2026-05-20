// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISupersetHubPoolManager
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for Superset's hub-chain entrypoint used by SupersetFacet
/// @dev Mirrors `HubPoolManager.multiHopSwapWithOutputChain` from
///      https://github.com/superset-finance/virtual-pools (`develop` branch).
///      The hub flow has no `refundAddress` or `options` because failures revert
///      synchronously on the hub itself and there's no source → hub LZ leg.
/// @custom:version 1.0.0
interface ISupersetHubPoolManager {
    /// @notice Initiate a cross-chain swap from the hub chain (Arbitrum) to a spoke
    /// @param _path Packed omniTokenId(32) || fee(3) || ... || omniTokenId(32)
    /// @param _amountIn Amount of the source omni-token pulled from msg.sender
    /// @param _amountOutMin Slippage floor on destination omni-token
    /// @param _recipient Address receiving `amountOut` on the destination spoke
    /// @param _fallbackEoA Pure EOA fall-through if delivery to `_recipient` fails
    /// @param _deadline Unix timestamp after which the hub rejects the request
    /// @param _toEid LayerZero endpoint ID of the destination spoke chain
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
