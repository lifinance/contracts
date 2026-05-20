// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title ISupersetSpokePoolManager
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for Superset's spoke-chain entrypoint used by SupersetFacet
/// @dev Mirrors `SpokePoolManager.multiHopSwapWithOutputChain` from
///      https://github.com/superset-finance/virtual-pools (`develop` branch).
///      Only the single function we call is included.
/// @custom:version 1.0.0
interface ISupersetSpokePoolManager {
    /// @notice Initiate a cross-chain swap via Superset's hub-and-spoke virtual pools
    /// @param _path Packed omniTokenId(32) || fee(3) || ... || omniTokenId(32); decoded hop-by-hop on the hub
    /// @param _amountIn Amount of the source omni-token pulled from msg.sender on the source spoke
    /// @param _amountOutMin Slippage floor on destination omni-token
    /// @param _recipient Address receiving `amountOut` on the destination spoke
    /// @param _refundAddress Address receiving `amountIn` on the source spoke if the swap fails
    /// @param _fallbackEoA Pure EOA fall-through if delivery to `_recipient`/`_refundAddress` fails;
    ///                     Superset validates `_fallbackEoA.code.length == 0` on the source
    /// @param _deadline Unix timestamp after which the hub will reject the request
    /// @param _toEid LayerZero endpoint ID of the destination spoke chain
    /// @param _options LayerZero executor options for the source → hub request
    function multiHopSwapWithOutputChain(
        bytes calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        address _recipient,
        address _refundAddress,
        address _fallbackEoA,
        uint256 _deadline,
        uint32 _toEid,
        bytes calldata _options
    ) external payable;
}
