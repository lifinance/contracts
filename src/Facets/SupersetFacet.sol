// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISupersetSpokePoolManager } from "../Interfaces/ISupersetSpokePoolManager.sol";
import { ISupersetHubPoolManager } from "../Interfaces/ISupersetHubPoolManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";

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

    /// @dev Diamond storage namespace.
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.superset");

    /// Storage ///

    /// @notice Address of the Superset pool manager on the current chain.
    /// @dev On Arbitrum this is `HubPoolManager`; on spokes (Base, Unichain) this
    ///      is `SpokePoolManager`. The facet picks the matching ABI via `IS_HUB`.
    address public immutable POOL_MANAGER;

    /// @notice True when this facet was deployed on Superset's hub chain (Arbitrum).
    bool public immutable IS_HUB;

    /// Types ///

    /// @dev Entry used to seed or update the chainId ↔ LayerZero EID mapping.
    /// @param chainId LI.FI chain ID (e.g. 8453 for Base).
    /// @param lzEid LayerZero endpoint ID for the same chain (e.g. 30184 for Base).
    struct ChainIdConfig {
        uint256 chainId;
        uint32 lzEid;
    }

    /// @dev Diamond storage layout. `lzEids[chainId] == 0` means "unset" — safe
    ///      because LayerZero does not assign EID 0 (v1 starts at 101, v2 at 30000).
    struct Storage {
        mapping(uint256 => uint32) lzEids;
        bool chainMappingsInitialized;
    }

    /// @dev Superset-specific parameters supplied by the LI.FI backend.
    /// @param path Packed `omniTokenId(32) || fee(3) || ... || omniTokenId(32)` describing
    ///        the multi-hop route on the hub's virtual Uniswap-V3 pools.
    /// @param amountOutMin Backend-quoted slippage floor on the destination omni-token
    ///        (absolute amount, in destination-token raw units). On
    ///        `startBridgeTokensViaSuperset` it is forwarded as-is. On
    ///        `swapAndStartBridgeTokensViaSuperset` the quoted value is calibrated to
    ///        the pre-swap `bridgeData.minAmount` (the swap floor); after the swap the
    ///        facet scales it by `actualPostSwap / preSwapFloor` so the percentage
    ///        bridge-slippage tolerance is preserved against the real swap result. Example:
    ///        backend says "if the swap returns its 100 USDC floor, accept ≥ 99 USDC on
    ///        the destination." If the swap actually returns 110 USDC, the facet uses
    ///        `99 * 110 / 100 = 108.9 USDC` instead of the static 99 from the quote.
    /// @param refundAddress Source-chain address that receives source-side excess native
    ///        and any swap leftovers from `swapAndStartBridgeTokensViaSuperset`. On a
    ///        spoke origin Superset also forwards `amountIn` here if the hub rejects the
    ///        swap (async failure). On a hub origin there is no async failure path, so
    ///        Superset itself ignores this field — but the facet still requires it to be
    ///        non-zero because the local refund sink is the same on both branches.
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

    /// Events ///

    /// @notice Emitted when the chainId ↔ LayerZero EID mapping is initialized.
    event SupersetChainMappingsInitialized(ChainIdConfig[] chainIdConfigs);

    /// @notice Emitted when a chainId ↔ LayerZero EID entry is set or updated.
    event ChainIdToEidSet(uint256 indexed chainId, uint32 lzEid);

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

    /// Admin Methods ///

    /// @notice Seeds the chainId ↔ LayerZero EID mapping (owner-only).
    /// @param _chainIdConfigs Batch of `{chainId, lzEid}` entries.
    /// @dev Overwrites any existing entries for the supplied chain IDs.
    function initSuperset(ChainIdConfig[] calldata _chainIdConfigs) external {
        if (_chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        Storage storage s = _getStorage();

        for (uint256 i = 0; i < _chainIdConfigs.length; ++i) {
            uint256 chainId = _chainIdConfigs[i].chainId;
            uint32 lzEid = _chainIdConfigs[i].lzEid;

            s.lzEids[chainId] = lzEid;
            // Per-entry event lets indexers subscribe to a single signal
            // (ChainIdToEidSet) for both initial seeding and later updates.
            emit ChainIdToEidSet(chainId, lzEid);
        }

        s.chainMappingsInitialized = true;

        emit SupersetChainMappingsInitialized(_chainIdConfigs);
    }

    /// @notice Adds or updates chainId ↔ LayerZero EID entries (owner-only).
    /// @param _chainIdConfigs Batch of `{chainId, lzEid}` entries.
    function setChainIdToEid(
        ChainIdConfig[] calldata _chainIdConfigs
    ) external {
        if (_chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        Storage storage s = _getStorage();
        if (!s.chainMappingsInitialized) revert NotInitialized();

        for (uint256 i = 0; i < _chainIdConfigs.length; ++i) {
            uint256 chainId = _chainIdConfigs[i].chainId;
            uint32 lzEid = _chainIdConfigs[i].lzEid;

            s.lzEids[chainId] = lzEid;
            emit ChainIdToEidSet(chainId, lzEid);
        }
    }

    /// @notice Returns the LayerZero EID configured for `_chainId`.
    /// @param _chainId LI.FI chain ID to look up.
    /// @return lzEid LayerZero endpoint ID.
    function getChainIdToEid(
        uint256 _chainId
    ) public view returns (uint32 lzEid) {
        lzEid = _getStorage().lzEids[_chainId];
        if (lzEid == 0) revert UnsupportedChainId(_chainId);
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
        _validateSupersetData(_bridgeData.destinationChainId, _supersetData);

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
        _validateSupersetData(_bridgeData.destinationChainId, _supersetData);

        uint256 preSwapMinAmount = _bridgeData.minAmount;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_supersetData.refundAddress),
            _supersetData.lzFee
        );

        // Scale the destination floor by the same proportion the swap exceeded
        // its floor, so the backend's percentage bridge-slippage budget is
        // preserved against the actual post-swap amount.
        // `_depositAndSwap` reverts when the swap returns less than the floor,
        // so by here `_bridgeData.minAmount >= preSwapMinAmount` and the ratio
        // never tightens the floor. `validateBridgeData` already rejects
        // `_bridgeData.minAmount == 0`, so `preSwapMinAmount > 0`.
        SupersetData memory modifiedSupersetData = _supersetData;
        modifiedSupersetData.amountOutMin =
            (_supersetData.amountOutMin * _bridgeData.minAmount) /
            preSwapMinAmount;

        _startBridge(_bridgeData, modifiedSupersetData);
    }

    /// Internal Methods ///

    /// @dev Validates Superset-specific data. Native source asset is rejected
    ///      by the `noNativeAsset` modifier on each external entry.
    /// @param _destinationChainId LI.FI chain ID of the destination spoke.
    /// @param _supersetData Superset-specific parameters
    function _validateSupersetData(
        uint256 _destinationChainId,
        SupersetData calldata _supersetData
    ) internal view {
        if (_supersetData.path.length == 0) {
            revert InvalidConfig();
        }

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

        if (block.timestamp > _supersetData.deadline) {
            revert InvalidConfig();
        }

        // Ensure backend-supplied `toEid` resolves to the same LayerZero endpoint
        // as `bridgeData.destinationChainId` would. Reverts `UnsupportedChainId`
        // if no mapping is configured for the destination chain.
        if (getChainIdToEid(_destinationChainId) != _supersetData.toEid) {
            revert InvalidConfig();
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

    /// @dev Fetches diamond storage.
    function _getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
