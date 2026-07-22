// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IFraxHopV2, IFraxOFT, ITipFeeManager } from "../Interfaces/IFraxHopV2.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig, NotInitialized, UnsupportedChainId } from "../Errors/GenericErrors.sol";

/// @title FraxFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Frax HopV2, a LayerZero V2
///         OFT hub-and-spoke bridge (hub on Fraxtal, spokes on every other chain).
/// @dev This facet is not intended to custody user funds. Tokens are pulled, floored to
///      the OFT's dust granularity, forwarded to the HopV2 contract in the same call, and
///      any dust remainder plus excess native fee are returned to the refundRecipient within
///      the same transaction; no balance is meant to persist between calls.
/// @custom:version 1.0.0
contract FraxFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Constants ///

    /// @dev Diamond storage namespace for the chainId -> LayerZero EID mapping.
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.frax");

    /// Storage ///

    /// @notice The Frax HopV2 contract on this chain (hub on Fraxtal, spoke elsewhere).
    ///         This is also the token approval target ("approvalAddress").
    IFraxHopV2 public immutable HOP;

    /// @notice The Tempo TIP20 fee manager. Non-zero ONLY on Tempo, whose LayerZero
    ///         EndpointV2Alt rejects native msg.value and charges the messaging fee in an
    ///         ERC20 gas token instead. Zero on every standard chain, which selects the
    ///         native-fee path. This single immutable is what lets one FraxFacet source
    ///         serve every chain (see docs/FraxFacet.md).
    address public immutable TIP_FEE_MANAGER;

    /// @notice The default Tempo gas token (PATH_USD) used when the diamond has not opted
    ///         into a specific TIP20 gas token. Set only on Tempo; zero elsewhere.
    address public immutable PATH_USD;

    /// Types ///

    /// @dev Entry used to seed or update the chainId -> LayerZero EID mapping.
    /// @param chainId LI.FI chain ID (e.g. 252 for Fraxtal).
    /// @param lzEid LayerZero endpoint ID for the same chain (e.g. 30255 for Fraxtal).
    struct ChainIdConfig {
        uint256 chainId;
        uint32 lzEid;
    }

    /// @dev Diamond storage layout. `lzEids[chainId] == 0` means "unset" — safe because
    ///      LayerZero does not assign EID 0 (v1 starts at 101, v2 at 30000).
    struct Storage {
        mapping(uint256 => uint32) lzEids;
        bool chainMappingsInitialized;
    }

    /// @param oft The OFT messenger for the token on the source chain (its token() is the
    ///        ERC20 that HopV2 pulls and that must equal bridgeData.sendingAssetId)
    /// @param dstEid The LayerZero endpoint ID of the destination chain. Cross-checked
    ///        against the EID configured for bridgeData.destinationChainId.
    /// @param nativeFee The native LayerZero fee forwarded to HopV2 as msg.value on standard
    ///        chains; ignored on Tempo (fee is paid in the TIP20 gas token)
    /// @param refundRecipient Address that receives pre-bridge swap leftovers, the dust
    ///        remainder that HopV2 does not bridge, and any excess native that HopV2 refunds
    ///        to the diamond mid-call. Must accept plain native transfers.
    struct FraxData {
        address oft;
        uint32 dstEid;
        uint256 nativeFee;
        address refundRecipient;
    }

    /// Events ///

    /// @notice Emitted when the chainId -> LayerZero EID mapping is initialized.
    event FraxChainMappingsInitialized(ChainIdConfig[] chainIdConfigs);

    /// @notice Emitted when a chainId -> LayerZero EID entry is set or updated.
    event FraxChainIdToEidSet(uint256 indexed chainId, uint32 lzEid);

    /// Constructor ///

    /// @notice Initializes the FraxFacet
    /// @param _hop The Frax HopV2 contract on this chain
    /// @param _tipFeeManager The Tempo TIP20 fee manager (address(0) on non-Tempo chains)
    /// @param _pathUsd The default Tempo gas token PATH_USD (address(0) on non-Tempo chains)
    constructor(IFraxHopV2 _hop, address _tipFeeManager, address _pathUsd) {
        // The Tempo fee-token path needs both the fee manager and a default gas token; they
        // are either both set (Tempo) or both zero (every standard chain). A half-configured
        // deployment would revert deep inside the Tempo branch at bridge time.
        if (
            address(_hop) == address(0) ||
            ((_tipFeeManager == address(0)) != (_pathUsd == address(0)))
        ) {
            revert InvalidConfig();
        }
        HOP = _hop;
        TIP_FEE_MANAGER = _tipFeeManager;
        PATH_USD = _pathUsd;
    }

    /// Admin Methods ///

    /// @notice Seeds the chainId -> LayerZero EID mapping (owner-only).
    /// @param _chainIdConfigs Batch of `{chainId, lzEid}` entries.
    /// @dev Overwrites any existing entries for the supplied chain IDs.
    function initFrax(ChainIdConfig[] calldata _chainIdConfigs) external {
        if (_chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        Storage storage s = _getStorage();

        for (uint256 i = 0; i < _chainIdConfigs.length; ++i) {
            uint256 chainId = _chainIdConfigs[i].chainId;
            uint32 lzEid = _chainIdConfigs[i].lzEid;

            // `lzEid == 0` collides with the "unset" sentinel, so it would emit a
            // successful event yet leave the chain unusable; `chainId == 0` can never
            // match a real destination.
            if (chainId == 0 || lzEid == 0) revert InvalidConfig();

            s.lzEids[chainId] = lzEid;
            emit FraxChainIdToEidSet(chainId, lzEid);
        }

        s.chainMappingsInitialized = true;

        emit FraxChainMappingsInitialized(_chainIdConfigs);
    }

    /// @notice Adds or updates chainId -> LayerZero EID entries (owner-only).
    /// @param _chainIdConfigs Batch of `{chainId, lzEid}` entries.
    function setFraxChainIdToEid(
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
            emit FraxChainIdToEidSet(chainId, lzEid);
        }
    }

    /// @notice Returns the LayerZero EID configured for `_chainId`.
    /// @param _chainId LI.FI chain ID to look up.
    /// @return lzEid LayerZero endpoint ID.
    function getFraxChainIdToEid(
        uint256 _chainId
    ) public view returns (uint32 lzEid) {
        lzEid = _getStorage().lzEids[_chainId];
        if (lzEid == 0) revert UnsupportedChainId(_chainId);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Frax HopV2
    /// @param _bridgeData The core information needed for bridging
    /// @param _fraxData Data specific to Frax HopV2
    function startBridgeTokensViaFrax(
        ILiFi.BridgeData calldata _bridgeData,
        FraxData calldata _fraxData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_fraxData.refundRecipient))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateFraxData(_bridgeData.destinationChainId, _fraxData);

        // On standard chains the LayerZero fee is the only native outflow and must come from
        // msg.value, never from stray diamond balance. On Tempo the fee is an ERC20, so no
        // native should be sent at all (EndpointV2Alt would revert on non-zero msg.value).
        if (TIP_FEE_MANAGER == address(0)) {
            if (_fraxData.nativeFee > msg.value) {
                revert InvalidCallData();
            }
        } else if (msg.value != 0) {
            revert InvalidCallData();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _fraxData);
    }

    /// @notice Performs a swap before bridging via Frax HopV2
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _fraxData Data specific to Frax HopV2
    function swapAndStartBridgeTokensViaFrax(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        FraxData calldata _fraxData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_fraxData.refundRecipient))
        validateBridgeData(_bridgeData)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateFraxData(_bridgeData.destinationChainId, _fraxData);

        // On Tempo the fee is an ERC20 and no native is ever consumed; reject stray msg.value
        // here too (symmetric with the non-swap path) so it fails fast instead of being
        // silently refunded late.
        if (TIP_FEE_MANAGER != address(0) && msg.value != 0) {
            revert InvalidCallData();
        }

        // The final swap output must be the bridged asset: _depositAndSwap measures the
        // slippage floor in the last swap's receivingAssetId, while _startBridge floors,
        // approves and bridges _bridgeData.sendingAssetId. A mismatch would validate one token
        // and bridge another. An empty array is left to _depositAndSwap (reverts NoSwapData).
        if (
            _swapData.length != 0 &&
            _swapData[_swapData.length - 1].receivingAssetId !=
            _bridgeData.sendingAssetId
        ) {
            revert InformationMismatch();
        }

        // NOTE: nativeFee is intentionally NOT checked against msg.value here (unlike the
        // non-swap path): on standard chains the fee may be funded by an ERC20->native
        // pre-swap whose output the nativeReserve below keeps in the diamond. On Tempo the
        // fee is an ERC20 and there is no native reserve.
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_fraxData.refundRecipient),
            TIP_FEE_MANAGER == address(0) ? _fraxData.nativeFee : 0
        );

        _startBridge(_bridgeData, _fraxData);
    }

    /// Internal Methods ///

    /// @dev Validates FraxData fields shared by both entry points
    /// @param _destinationChainId The LI.FI destination chain ID from bridgeData
    /// @param _fraxData Data specific to Frax HopV2
    function _validateFraxData(
        uint256 _destinationChainId,
        FraxData calldata _fraxData
    ) internal view {
        // refundExcessNative forwards excess native to refundRecipient; a zero address would
        // only revert late, when fee drift happens to leave an excess. Fail fast instead.
        // dstEid == 0 is never a valid LayerZero endpoint and would strand the transfer.
        if (
            _fraxData.refundRecipient == address(0) ||
            _fraxData.oft == address(0) ||
            _fraxData.dstEid == 0
        ) {
            revert InvalidCallData();
        }

        // dstEid is the actual LayerZero routing target and is trusted from backend calldata;
        // bridgeData.destinationChainId is what analytics/accounting index on. Bind them so a
        // caller cannot route funds to one chain while the transfer is recorded as another.
        // getFraxChainIdToEid reverts UnsupportedChainId when the destination is not configured.
        if (getFraxChainIdToEid(_destinationChainId) != _fraxData.dstEid) {
            revert InformationMismatch();
        }
    }

    /// @dev Contains the business logic for bridging via Frax HopV2
    /// @param _bridgeData The core information needed for bridging
    /// @param _fraxData Data specific to Frax HopV2
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        FraxData calldata _fraxData
    ) internal {
        // The OFT's underlying token must be exactly what we bridge; otherwise HopV2 would
        // pull a different asset than the one deposited/validated here.
        if (IFraxOFT(_fraxData.oft).token() != _bridgeData.sendingAssetId) {
            revert InformationMismatch();
        }

        // HopV2 floors the amount to the OFT's dust granularity and only pulls the floored
        // amount. Compute it up front so we approve and bridge exactly that, and can return
        // the un-bridged dust to the user instead of leaving it stranded in the diamond.
        uint256 flooredAmount = HOP.removeDust(
            _fraxData.oft,
            _bridgeData.minAmount
        );
        if (flooredAmount == 0) {
            revert InvalidCallData();
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(HOP),
            flooredAmount
        );

        bytes32 recipient = bytes32(uint256(uint160(_bridgeData.receiver)));

        if (TIP_FEE_MANAGER == address(0)) {
            HOP.sendOFT{ value: _fraxData.nativeFee }(
                _fraxData.oft,
                _fraxData.dstEid,
                recipient,
                flooredAmount,
                0,
                ""
            );
        } else {
            _sendViaTempo(
                _fraxData,
                _bridgeData.sendingAssetId,
                recipient,
                flooredAmount
            );
        }

        // Return the dust that HopV2 did not bridge to the user (never leave it in the diamond)
        uint256 dust = _bridgeData.minAmount - flooredAmount;
        if (dust != 0) {
            LibAsset.transferAsset(
                _bridgeData.sendingAssetId,
                payable(_fraxData.refundRecipient),
                dust
            );
        }

        // Emit the amount actually bridged so downstream accounting matches what arrives on dst
        _bridgeData.minAmount = flooredAmount;

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Tempo (EndpointV2Alt) send path. Tempo rejects native msg.value and charges the
    ///      LayerZero fee in a TIP20 ERC20 gas token, which HopV2 pulls from the diamond
    ///      (msg.sender) via transferFrom. So the diamond must (1) hold that fee token and
    ///      (2) approve it to HopV2, in addition to the bridged-token approval above. The fee
    ///      token is the one the diamond opted into via TIP_FEE_MANAGER, else PATH_USD; its
    ///      amount is quoted in-token by HopV2.quoteStatic. msg.value is 0.
    /// @dev BE-integration note (EXP-514): the fee token must be made available to the diamond
    ///      by the caller for the transferFrom pull to succeed - see docs/FraxFacet.md.
    /// @param _fraxData Data specific to Frax HopV2
    /// @param _sendingAssetId The bridged ERC20 (bridgeData.sendingAssetId)
    /// @param _recipient bytes32-encoded destination recipient
    /// @param _amount The dust-floored amount to bridge
    function _sendViaTempo(
        FraxData calldata _fraxData,
        address _sendingAssetId,
        bytes32 _recipient,
        uint256 _amount
    ) internal {
        address feeToken = ITipFeeManager(TIP_FEE_MANAGER).userTokens(
            address(this)
        );
        if (feeToken == address(0)) {
            feeToken = PATH_USD;
        }

        // The unused-fee sweep below tracks the fee token by a balance delta taken after the
        // bridged token has already been deposited. If the fee token were the same ERC20 we
        // are bridging, that delta would conflate the two flows and could strand the bridged
        // amount in the diamond. A Frax gas token is never the bridged OFT, so reject the
        // collision rather than mis-account for it.
        if (feeToken == _sendingAssetId) {
            revert InformationMismatch();
        }

        uint256 feeAmount = HOP.quoteStatic(
            _fraxData.oft,
            _fraxData.dstEid,
            _recipient,
            _amount,
            0,
            "",
            feeToken
        );

        // Snapshot before the deposit so any fee token HopV2 does not pull can be returned to
        // the user without touching a pre-existing diamond balance. quoteStatic and sendOFT run
        // in the same tx so the pull normally equals feeAmount, but this keeps the "diamond
        // retains nothing" invariant even if HopV2's fee logic changes on a proxy upgrade.
        uint256 feeTokenBalanceBefore = IERC20(feeToken).balanceOf(
            address(this)
        );

        if (feeAmount != 0) {
            LibAsset.depositAsset(feeToken, feeAmount);
            LibAsset.maxApproveERC20(
                IERC20(feeToken),
                address(HOP),
                feeAmount
            );
        }

        HOP.sendOFT(
            _fraxData.oft,
            _fraxData.dstEid,
            _recipient,
            _amount,
            0,
            ""
        );

        // Sweep only the fee token HopV2 did not pull. Guard the subtraction: the same
        // proxy-upgrade drift the snapshot defends against could make HopV2 pull MORE than
        // quoted, and if the diamond held any incidental pre-existing feeToken balance the
        // post-send balance can fall below the baseline. An over-pull must degrade to "no
        // refund", never revert an otherwise-valid bridge with an arithmetic panic.
        uint256 feeTokenBalanceAfter = IERC20(feeToken).balanceOf(
            address(this)
        );
        uint256 unusedFee = feeTokenBalanceAfter > feeTokenBalanceBefore
            ? feeTokenBalanceAfter - feeTokenBalanceBefore
            : 0;
        if (unusedFee != 0) {
            LibAsset.transferAsset(
                feeToken,
                payable(_fraxData.refundRecipient),
                unusedFee
            );
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
