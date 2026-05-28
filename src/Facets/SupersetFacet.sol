// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISupersetSpokePoolManager } from "../Interfaces/ISupersetSpokePoolManager.sol";
import { ISupersetHubPoolManager } from "../Interfaces/ISupersetHubPoolManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title SupersetFacet
/// @author LI.FI (https://li.fi)
/// @notice Bridges stablecoins via Superset's hub-and-spoke virtual pools
///         (LayerZero messaging; hub on Arbitrum).
/// @dev    Same protocol exposes two slightly different ABIs depending on whether
///         the facet is deployed on the hub chain or on a spoke chain. The branch
///         is selected by `IS_HUB`, derived once at construction time from
///         `block.chainid`.
///         Native source asset is not supported because Superset does not support it.
/// @custom:version 1.0.0
contract SupersetFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Constants ///

    /// @notice Chain ID of Arbitrum One (the Superset hub).
    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;

    /// Storage ///

    /// @notice Address of the Superset pool manager on the current chain.
    /// @dev On Arbitrum this is `HubPoolManager`; on spokes (Base, Unichain) this
    ///      is `SpokePoolManager`. The facet picks the matching ABI via `IS_HUB`.
    address public immutable POOL_MANAGER;

    /// @notice True when this facet was deployed on Superset's hub chain (Arbitrum).
    bool public immutable IS_HUB;

    /// Types ///

    /// @dev Superset-specific parameters supplied by the LI.FI backend.
    /// @param path Packed `omniTokenId(32) || fee(3) || ... || omniTokenId(32)` describing
    ///        the multi-hop route on the hub's virtual Uniswap-V3 pools.
    /// @param amountOutMin Slippage floor on destination omni-token (absolute amount).
    /// @param amountOutMinPercent Fraction (1e18 = 100%) used to recompute `amountOutMin`
    ///        post source-swap so positive slippage propagates to the destination floor.
    /// @param refundAddress Source-chain address that receives `amountIn` if the swap
    ///        fails, plus any source-side excess native and swap leftovers. Must be
    ///        non-zero. Superset ignores it on the hub branch, but the facet still uses
    ///        it as the local refund sink.
    /// @param fallbackEoA Pure EOA fall-through if delivery to `bridgeData.receiver` or
    ///        `refundAddress` fails. Superset validates this is a pure EOA on the source;
    ///        we double-check on the facet for a cheaper revert.
    /// @param deadline Unix timestamp after which the hub will reject the request.
    /// @param toEid LayerZero endpoint ID of the destination spoke chain.
    /// @param options LayerZero executor options for the source → hub request. Ignored
    ///        on the hub branch (no source → hub LZ leg).
    /// @param lzFee Native value forwarded to the pool manager (`msg.value`). On a spoke
    ///        covers all three LZ messages; on the hub covers only the hub → destination
    ///        delivery message.
    struct SupersetData {
        bytes path;
        uint256 amountOutMin;
        uint64 amountOutMinPercent;
        address refundAddress;
        address fallbackEoA;
        uint256 deadline;
        uint32 toEid;
        bytes options;
        uint256 lzFee;
    }

    /// Errors ///

    /// @notice Thrown when `msg.value` does not cover the declared `lzFee`.
    error InsufficientNativeValue();

    /// Constructor ///

    /// @param _poolManager Superset `HubPoolManager` on Arbitrum or `SpokePoolManager` on
    ///        a spoke chain. The facet auto-detects role via `block.chainid`.
    constructor(address _poolManager) {
        if (_poolManager == address(0)) {
            revert InvalidConfig();
        }
        POOL_MANAGER = _poolManager;
        IS_HUB = block.chainid == ARBITRUM_CHAIN_ID;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Superset
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function startBridgeTokensViaSuperset(
        ILiFi.BridgeData calldata _bridgeData,
        SupersetData calldata _supersetData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_supersetData.refundAddress))
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateSupersetData(_supersetData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _supersetData);
    }

    /// @notice Performs a swap before bridging via Superset
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _swapData Source-chain swap(s) executed before bridging
    /// @param _supersetData Superset-specific parameters
    function swapAndStartBridgeTokensViaSuperset(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SupersetData calldata _supersetData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_supersetData.refundAddress))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateSupersetData(_supersetData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_supersetData.refundAddress),
            _supersetData.lzFee
        );

        // Adjust destination slippage floor for positive source-side slippage
        SupersetData memory modifiedSupersetData = _supersetData;
        modifiedSupersetData.amountOutMin =
            (_bridgeData.minAmount * _supersetData.amountOutMinPercent) /
            1e18;

        _startBridge(_bridgeData, modifiedSupersetData);
    }

    /// Internal Methods ///

    /// @dev Validates Superset-specific data. Native source asset is rejected
    ///      by the `noNativeAsset` modifier on each external entry.
    /// @param _supersetData Superset-specific parameters
    function _validateSupersetData(
        SupersetData calldata _supersetData
    ) internal view {
        // refundAddress also receives source-side excess native and swap leftovers,
        // so it must be set even on the hub branch where Superset itself ignores it.
        if (_supersetData.refundAddress == address(0)) {
            revert InvalidConfig();
        }

        // Must be a non-zero EOA
        if (
            _supersetData.fallbackEoA == address(0) ||
            _supersetData.fallbackEoA.code.length != 0
        ) {
            revert InvalidConfig();
        }

        if (msg.value < _supersetData.lzFee) {
            revert InsufficientNativeValue();
        }
    }

    /// @dev Bridge execution: approves the pool manager, then calls the hub or spoke
    ///      ABI depending on `IS_HUB`.
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SupersetData memory _supersetData
    ) internal {
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            POOL_MANAGER,
            _bridgeData.minAmount
        );

        if (IS_HUB) {
            // Hub flow: no `refundAddress`/`options` (failures revert synchronously
            // on the hub; no source → hub LZ leg).
            ISupersetHubPoolManager(POOL_MANAGER).multiHopSwapWithOutputChain{
                value: _supersetData.lzFee
            }({
                _path: _supersetData.path,
                _amountIn: _bridgeData.minAmount,
                _amountOutMin: _supersetData.amountOutMin,
                _recipient: _bridgeData.receiver,
                _fallbackEoA: _supersetData.fallbackEoA,
                _deadline: _supersetData.deadline,
                _toEid: _supersetData.toEid
            });
        } else {
            ISupersetSpokePoolManager(POOL_MANAGER)
                .multiHopSwapWithOutputChain{ value: _supersetData.lzFee }({
                _path: _supersetData.path,
                _amountIn: _bridgeData.minAmount,
                _amountOutMin: _supersetData.amountOutMin,
                _recipient: _bridgeData.receiver,
                _refundAddress: _supersetData.refundAddress,
                _fallbackEoA: _supersetData.fallbackEoA,
                _deadline: _supersetData.deadline,
                _toEid: _supersetData.toEid,
                _options: _supersetData.options
            });
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
