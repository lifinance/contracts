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
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title SupersetFacet
/// @author LI.FI (https://li.fi)
/// @notice Bridges stablecoins via Superset's hub-and-spoke virtual pools
///         (LayerZero messaging; hub on Arbitrum, spokes on Base/Unichain).
/// @dev    Same protocol exposes two slightly different ABIs depending on whether
///         the facet is deployed on the hub chain or on a spoke chain. The branch
///         is selected by `IS_HUB`, derived once at construction time from
///         `block.chainid`. Storage layout is identical across deployments.
///         Native source asset is not supported because Superset does not support it.
///         This contract is not intended to custody user funds. Any balance held
///         is transient during a single transaction and should not persist across calls.
/// @custom:version 1.0.0
contract SupersetFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    /// @notice Chain ID of Arbitrum One (the Superset hub).
    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;

    /// Storage ///

    /// @notice Address of the Superset pool manager on the current chain.
    /// @dev On Arbitrum this is `HubPoolManager`; on spokes (Base, Unichain) this
    ///      is `SpokePoolManager`. The facet picks the matching ABI via `IS_HUB`.
    // solhint-disable-next-line immutable-vars-naming
    address public immutable POOL_MANAGER;

    /// @notice True when this facet was deployed on Superset's hub chain (Arbitrum).
    // solhint-disable-next-line immutable-vars-naming
    bool public immutable IS_HUB;

    /// Types ///

    /// @dev Superset-specific parameters supplied by the LI.FI backend.
    /// @param path Packed `omniTokenId(32) || fee(3) || ... || omniTokenId(32)` describing
    ///        the multi-hop route on the hub's virtual Uniswap-V3 pools.
    /// @param amountOutMin Slippage floor on destination omni-token (absolute amount).
    /// @param amountOutMinPercent Fraction (1e18 = 100%) used to recompute `amountOutMin`
    ///        post source-swap so positive slippage propagates to the destination floor.
    /// @param refundAddress Address that receives `amountIn` on the source spoke if the
    ///        swap fails. Ignored on the hub branch (hub failures revert synchronously).
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

    /// @notice Thrown when `fallbackEoA` is a contract (i.e. has bytecode).
    error InvalidFallbackEoA(address fallbackEoA);

    /// @notice Thrown when `msg.value` does not cover the declared `lzFee`.
    error InsufficientNativeValue();

    /// @notice Thrown when `SupersetData.path` is shorter than the minimum encoding
    ///         (one hop = 32 + 3 + 32 = 67 bytes).
    error InvalidSupersetPath();

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
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateSupersetData(_bridgeData, _supersetData);

        if (msg.value < _supersetData.lzFee) {
            revert InsufficientNativeValue();
        }

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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateSupersetData(_bridgeData, _supersetData);

        // Reserve lzFee from msg.value so it isn't swept back to the user
        // when SwapperV2 refunds leftover native.
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _supersetData.lzFee
        );

        // Adjust destination slippage floor for positive source-side slippage
        // ([CONV:FACET-REQS] positive slippage handling).
        SupersetData memory modifiedSupersetData = _supersetData;
        modifiedSupersetData.amountOutMin =
            (_bridgeData.minAmount * _supersetData.amountOutMinPercent) /
            1e18;

        _startBridge(_bridgeData, modifiedSupersetData);
    }

    /// Internal Methods ///

    /// @dev Validates Superset-specific data. Native source asset is rejected
    ///      by the `noNativeAsset` modifier on each external entry.
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function _validateSupersetData(
        ILiFi.BridgeData memory _bridgeData,
        SupersetData calldata _supersetData
    ) internal view {
        // Superset has no non-EVM spokes; reject explicitly.
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            revert InvalidNonEVMReceiver();
        }

        // Minimum single-hop encoding is omniTokenId(32) || fee(3) || omniTokenId(32) = 67 bytes.
        if (_supersetData.path.length < 67) {
            revert InvalidSupersetPath();
        }

        // Defense-in-depth: Superset already validates this on the source side
        // (`SwapDelivery.resolveAndValidateFallbackEoA`); reverting earlier here
        // saves gas on bad inputs.
        if (_supersetData.fallbackEoA.code.length != 0) {
            revert InvalidFallbackEoA(_supersetData.fallbackEoA);
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
            }(
                _supersetData.path,
                _bridgeData.minAmount,
                _supersetData.amountOutMin,
                _bridgeData.receiver,
                _supersetData.fallbackEoA,
                _supersetData.deadline,
                _supersetData.toEid
            );
        } else {
            ISupersetSpokePoolManager(POOL_MANAGER)
                .multiHopSwapWithOutputChain{ value: _supersetData.lzFee }(
                _supersetData.path,
                _bridgeData.minAmount,
                _supersetData.amountOutMin,
                _bridgeData.receiver,
                _supersetData.refundAddress,
                _supersetData.fallbackEoA,
                _supersetData.deadline,
                _supersetData.toEid,
                _supersetData.options
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
