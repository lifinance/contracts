// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISupersetSpokePoolManager } from "../Interfaces/ISupersetSpokePoolManager.sol";
import { ISupersetHubPoolManager } from "../Interfaces/ISupersetHubPoolManager.sol";
import { ISupersetPoolManager } from "../Interfaces/ISupersetPoolManager.sol";
import { IOmniTokenAddressBook } from "../Interfaces/IOmniTokenAddressBook.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { DeadlineExpired, InvalidAmount, InvalidConfig, InvalidReceiver, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";
import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";

/// @title SupersetFacet
/// @author LI.FI (https://li.fi)
/// @notice Bridges stablecoins via Superset's hub-and-spoke virtual pools
///         (LayerZero messaging; hub on Arbitrum). Also supports same-chain
///         swaps (DEX mode) when `bridgeData.destinationChainId == block.chainid`.
/// @dev    Same protocol exposes different ABIs depending on (hub vs spoke) ×
///         (same-chain vs cross-chain). Role is selected by `IS_HUB` (derived
///         once at construction from `block.chainid`); same-chain is selected
///         when `bridgeData.destinationChainId == block.chainid`:
///         - spoke same-chain → `SpokePoolManager.multiHopSwap` (LZ round-trip)
///         - spoke cross-chain → `SpokePoolManager.multiHopSwapWithOutputChain`
///         - hub same-chain → `HubPoolManager.exactInput` (atomic; omni path
///           converted to a Uniswap-V3 address path on-chain)
///         - hub cross-chain → `HubPoolManager.multiHopSwapWithOutputChain`
///         Native source asset is not supported because Superset does not support it.
/// @custom:version 1.1.0
contract SupersetFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// @notice Validates bridge data for Superset transfers.
    /// @dev Does not enforce a same-network guard because same-chain swaps
    ///      (Superset DEX mode) are supported.
    /// @param _bridgeData The core information needed for bridging
    modifier validateBridgeDataSuperset(ILiFi.BridgeData memory _bridgeData) {
        if (LibUtil.isZeroAddress(_bridgeData.receiver)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        _;
    }

    /// Constants ///

    /// @notice Chain ID of Arbitrum One (the Superset hub).
    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;

    /// @dev Byte width of a single packed OmniToken ID at the head of `SupersetData.path`.
    uint256 internal constant OMNI_TOKEN_ID_BYTES = 32;

    /// @dev Byte width of a packed Uniswap-V3 fee tier between path tokens.
    uint256 internal constant FEE_BYTES = 3;

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
    ///        Must be non-zero: a zero floor disables the pool manager's slippage
    ///        check and is never a legitimate quote.
    /// @param refundAddress Source-chain address that receives source-side excess native
    ///        and any swap leftovers from `swapAndStartBridgeTokensViaSuperset`. On a
    ///        spoke origin Superset also forwards `amountIn` here if the hub rejects the
    ///        swap (async failure). On a hub origin there is no async failure path, so
    ///        Superset itself ignores this field — but the facet still requires it to be
    ///        non-zero because the local refund sink is the same on both branches.
    /// @param fallbackEoA Pure EOA fall-through if delivery to `bridgeData.receiver` or
    ///        `refundAddress` fails. Superset validates this is a pure EOA on the source;
    ///        we double-check on the facet for a cheaper revert. EIP-7702 delegated EOAs
    ///        are rejected (the 23-byte delegation designator counts as `code`).
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
        // TODO(EXSC-623): rename to the canonical `refundRecipient` per
        // [CONV:FACET-REFUNDS]. Deferred so the name-only change rides the next
        // audited change to this facet rather than forcing a standalone
        // re-audit (selectors and runtime bytecode are unaffected). Reference
        // implementation (rename + clear-signing regen + docs/tests): PR #2084.
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

            // `lzEid == 0` collides with the "unset" sentinel, so it would emit
            // a successful event yet leave the chain unusable; `chainId == 0`
            // can never match a real destination.
            if (chainId == 0 || lzEid == 0) revert InvalidConfig();

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

            if (chainId == 0 || lzEid == 0) revert InvalidConfig();

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
        validateBridgeDataSuperset(_bridgeData)
        noNativeAsset(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateSupersetData(
            _bridgeData.destinationChainId,
            _bridgeData.sendingAssetId,
            _supersetData
        );

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
        validateBridgeDataSuperset(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // The bridged token is the last swap's output, so it must match
        // `sendingAssetId` (the token the pool manager is approved to pull).
        if (
            _swapData.length > 0 &&
            _swapData[_swapData.length - 1].receivingAssetId !=
            _bridgeData.sendingAssetId
        ) {
            revert InvalidConfig();
        }

        _validateSupersetData(
            _bridgeData.destinationChainId,
            _bridgeData.sendingAssetId,
            _supersetData
        );

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
        // never tightens the floor. `validateBridgeDataSuperset` already rejects
        // `_bridgeData.minAmount == 0`, so `preSwapMinAmount > 0`.
        SupersetData memory modifiedSupersetData = _supersetData;
        modifiedSupersetData.amountOutMin = FixedPointMathLib.mulDiv(
            _supersetData.amountOutMin,
            _bridgeData.minAmount,
            preSwapMinAmount
        );

        _startBridge(_bridgeData, modifiedSupersetData);
    }

    /// Internal Methods ///

    /// @dev Validates Superset-specific data. Native source asset is rejected
    ///      by the `noNativeAsset` modifier on each external entry.
    /// @param _destinationChainId LI.FI chain ID of the destination spoke.
    /// @param _sendingAssetId Token the facet deposits and approves to the pool manager.
    /// @param _supersetData Superset-specific parameters
    function _validateSupersetData(
        uint256 _destinationChainId,
        address _sendingAssetId,
        SupersetData calldata _supersetData
    ) internal view {
        bool sameChain = _destinationChainId == block.chainid;

        // At least one hop: omniTokenId(32) || fee(3) || omniTokenId(32).
        if (
            _supersetData.path.length <
            OMNI_TOKEN_ID_BYTES + FEE_BYTES + OMNI_TOKEN_ID_BYTES
        ) {
            revert InvalidConfig();
        }
        if (
            (_supersetData.path.length - OMNI_TOKEN_ID_BYTES) %
                (FEE_BYTES + OMNI_TOKEN_ID_BYTES) !=
            0
        ) {
            revert InvalidConfig();
        }

        // A zero destination floor is never a valid quote: it disables the
        // pool manager's `amountOut >= amountOutMinimum` slippage check and
        // exposes the bridged amount to unbounded MEV.
        if (_supersetData.amountOutMin == 0) {
            revert InvalidConfig();
        }

        // The pool manager pulls the token resolved from the path's first
        // OmniToken ID, not the approved `sendingAssetId`. Bind them so a
        // mismatched path cannot drain a different (e.g. stuck) token from the
        // diamond via a stale allowance.
        uint256 firstOmniTokenId = abi.decode(
            _supersetData.path[:OMNI_TOKEN_ID_BYTES],
            (uint256)
        );
        IOmniTokenAddressBook addressBook = ISupersetPoolManager(POOL_MANAGER)
            .getOmniTokenAddressBook();
        if (
            addressBook.getAddressForOmniToken(firstOmniTokenId) !=
            _sendingAssetId
        ) {
            revert InvalidConfig();
        }

        // refundAddress also receives source-side excess native and swap leftovers,
        // so it must be set even on branches where Superset itself ignores it.
        if (_supersetData.refundAddress == address(0)) {
            revert InvalidConfig();
        }

        // Hub same-chain (`exactInput`) is atomic and has no fallbackEoA.
        // All other branches require a non-zero pure EOA.
        if (!(IS_HUB && sameChain)) {
            if (
                _supersetData.fallbackEoA == address(0) ||
                _supersetData.fallbackEoA.code.length != 0
            ) {
                revert InvalidConfig();
            }
        }

        if (msg.value < _supersetData.lzFee) {
            revert InsufficientNativeValue();
        }

        if (block.timestamp > _supersetData.deadline) {
            revert DeadlineExpired();
        }

        // Cross-chain only: bind backend `toEid` to the configured mapping.
        // Same-chain entrypoints do not take `toEid` (spoke `multiHopSwap` /
        // hub `exactInput`); Superset reverts with "cannot target local chain"
        // if `multiHopSwapWithOutputChain` is called with the local EID.
        if (!sameChain) {
            if (getChainIdToEid(_destinationChainId) != _supersetData.toEid) {
                revert InvalidConfig();
            }
        }
    }

    /// @dev Bridge/swap execution: approves the pool manager, then dispatches to
    ///      the matching Superset ABI for (hub|spoke) × (same-chain|cross-chain).
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

        bool sameChain = _bridgeData.destinationChainId == block.chainid;

        if (IS_HUB) {
            if (sameChain) {
                // Atomic hub DEX swap — no LZ fee / messaging.
                ISupersetHubPoolManager(POOL_MANAGER).exactInput(
                    ISupersetHubPoolManager.ExactInputParams({
                        path: _omniPathToLocalAddressPath(_supersetData.path),
                        recipient: _bridgeData.receiver,
                        deadline: _supersetData.deadline,
                        amountIn: _bridgeData.minAmount,
                        amountOutMinimum: _supersetData.amountOutMin
                    })
                );
            } else {
                // Hub → spoke: no `refundAddress`/`options` (failures revert
                // synchronously on the hub; no source → hub LZ leg).
                ISupersetHubPoolManager(POOL_MANAGER)
                    .multiHopSwapWithOutputChain{
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
            }
        } else if (sameChain) {
            // Spoke → hub → same spoke. Refunds collapse onto `receiver`.
            ISupersetSpokePoolManager(POOL_MANAGER).multiHopSwap{
                value: _supersetData.lzFee
            }({
                _path: _supersetData.path,
                _amountIn: _bridgeData.minAmount,
                _amountOutMin: _supersetData.amountOutMin,
                _recipient: _bridgeData.receiver,
                _fallbackEoA: _supersetData.fallbackEoA,
                _deadline: _supersetData.deadline,
                _options: _supersetData.options
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

    /// @dev Converts an OmniToken path (`omniId(32)||fee(3)||…`) to a Uniswap-V3
    ///      address path (`address(20)||fee(3)||…`) via the hub address book.
    /// @param _omniPath Packed OmniToken path from `SupersetData.path`
    /// @return localPath Packed local-address path for `HubPoolManager.exactInput`
    function _omniPathToLocalAddressPath(
        bytes memory _omniPath
    ) internal view returns (bytes memory localPath) {
        IOmniTokenAddressBook addressBook = ISupersetPoolManager(POOL_MANAGER)
            .getOmniTokenAddressBook();

        address tokenIn = addressBook.getAddressForOmniToken(
            _readUint256(_omniPath, 0)
        );
        if (tokenIn == address(0)) revert InvalidConfig();

        localPath = abi.encodePacked(tokenIn);

        uint256 offset = OMNI_TOKEN_ID_BYTES;
        while (offset < _omniPath.length) {
            uint24 fee = _readUint24(_omniPath, offset);
            offset += FEE_BYTES;

            address tokenOut = addressBook.getAddressForOmniToken(
                _readUint256(_omniPath, offset)
            );
            offset += OMNI_TOKEN_ID_BYTES;

            if (tokenOut == address(0)) revert InvalidConfig();

            localPath = abi.encodePacked(localPath, fee, tokenOut);
        }
    }

    /// @dev Reads a big-endian `uint256` from `_data` at byte `_offset`.
    function _readUint256(
        bytes memory _data,
        uint256 _offset
    ) private pure returns (uint256 value) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(add(_data, 32), _offset))
        }
    }

    /// @dev Reads a big-endian `uint24` from `_data` at byte `_offset`.
    function _readUint24(
        bytes memory _data,
        uint256 _offset
    ) private pure returns (uint24 value) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := shr(232, mload(add(add(_data, 32), _offset)))
        }
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
