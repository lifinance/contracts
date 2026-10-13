// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IPaxosTransit } from "../Interfaces/IPaxosTransit.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch, InvalidAmount, InvalidCallData, InvalidConfig, InvalidReceiver } from "../Errors/GenericErrors.sol";

/// @title PaxosTransitFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Paxos Transit. Also supports
///         same-chain swaps when `bridgeData.destinationChainId == block.chainid`.
/// @custom:version 2.0.0
contract PaxosTransitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The Paxos Transit station contract on the source chain.
    IPaxosTransit public immutable TRANSIT_STATION;

    /// @notice The station's own LayerZero endpoint ID; a quote routed here is a same-chain order.
    uint32 public immutable PAXOS_TRANSIT_THIS_CHAIN_EID;

    /// @notice The LI.FI distributor code (left-adjusted bytes32 encoding of "LIFI").
    bytes32 public constant LIFI_DISTRIBUTOR_CODE =
        0x4c49464900000000000000000000000000000000000000000000000000000000;

    /// Types ///

    /// @param quote The Paxos-signed quote describing the transit order
    /// @param signature The Paxos signature over the EIP-712 quote digest
    /// @param nativeFee The native amount forwarded to Transit to pay the LayerZero messaging fee.
    ///        Must be zero for same-chain orders.
    /// @param refundRecipient Address that receives swap leftovers and positive slippage
    ///        from pre-bridge swaps, as well as any excess source-side native — including
    ///        LayerZero fee overage that the TransitStation's endpoint refunds to the
    ///        diamond mid-call. Must accept plain native transfers: a refundRecipient
    ///        that rejects them reverts the whole bridge (self-inflicted).
    struct PaxosTransitData {
        IPaxosTransit.Quote quote;
        bytes signature;
        uint256 nativeFee;
        address refundRecipient;
    }

    /// Modifiers ///

    /// @notice Validates bridge data for Paxos Transit orders.
    /// @dev Does not enforce a same-network guard because same-chain
    ///      orders are supported; see _validateSameChainMode.
    /// @param _bridgeData The core information needed for bridging
    modifier validateBridgeDataPaxosTransit(
        ILiFi.BridgeData memory _bridgeData
    ) {
        if (LibUtil.isZeroAddress(_bridgeData.receiver)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        _;
    }

    /// Constructor ///

    /// @notice Initializes the PaxosTransitFacet
    /// @param _transitStation The address of the Paxos Transit station on the source chain
    constructor(IPaxosTransit _transitStation) {
        if (address(_transitStation) == address(0)) {
            revert InvalidConfig();
        }
        TRANSIT_STATION = _transitStation;
        PAXOS_TRANSIT_THIS_CHAIN_EID = _transitStation.thisChainEID();
    }

    /// External Methods ///

    /// @notice Bridges tokens via Paxos Transit
    /// @param _bridgeData The core information needed for bridging
    /// @param _paxosData Data specific to Paxos Transit
    function startBridgeTokensViaPaxosTransit(
        ILiFi.BridgeData memory _bridgeData,
        PaxosTransitData calldata _paxosData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_paxosData.refundRecipient))
        validateBridgeDataPaxosTransit(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // refundExcessNative sends excess native to refundRecipient; with a zero address
        // that transfer would only revert when LZ fee drift actually leaves an excess -
        // a data-dependent late revert. Fail fast instead.
        if (_paxosData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        _validateSameChainMode(_bridgeData, _paxosData);

        // The Paxos-signed quote locks the exact amount to bridge, so minAmount must match it
        if (_bridgeData.minAmount != _paxosData.quote.offerAmount) {
            revert InformationMismatch();
        }

        // The station's LayerZero fee must be paid from msg.value, never from diamond balance
        if (_paxosData.nativeFee > msg.value) {
            revert InvalidCallData();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _paxosData);
    }

    /// @notice Performs a swap before bridging via Paxos Transit
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _paxosData Data specific to Paxos Transit
    function swapAndStartBridgeTokensViaPaxosTransit(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        PaxosTransitData calldata _paxosData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_paxosData.refundRecipient))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeDataPaxosTransit(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // msg.sender may be a relayer or the Permit2Proxy, so value that belongs to the
        // user (swap leftovers, positive slippage and excess native) must go to an
        // explicit refundRecipient.
        if (_paxosData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        _validateSameChainMode(_bridgeData, _paxosData);

        uint256 offerAmount = _paxosData.quote.offerAmount;

        // The Paxos-signed quote locks the exact amount to bridge, so minAmount must match it
        // here too - this also extends validateBridgeDataPaxosTransit's non-zero minAmount guarantee
        // to the swap floor below.
        if (_bridgeData.minAmount != offerAmount) {
            revert InformationMismatch();
        }

        // The final swap output must be the asset that gets bridged: _depositAndSwap measures
        // receivedAmount in the last swap's receivingAssetId, while the slippage floor, the
        // positive-slippage refund, and submitOrder below all act on sendingAssetId. A mismatch
        // would apply those checks to the wrong token. An empty array is left to _depositAndSwap,
        // which reverts NoSwapDataProvided.
        if (
            _swapData.length != 0 &&
            _swapData[_swapData.length - 1].receivingAssetId !=
            _bridgeData.sendingAssetId
        ) {
            revert InformationMismatch();
        }

        // NOTE: nativeFee is intentionally NOT checked against msg.value here (unlike the
        // non-swap path): the fee may be funded by an ERC20->native pre-swap, whose output
        // the nativeReserve below keeps in the diamond for submitOrder.
        // The Paxos quote locks an exact offerAmount, so the swap must yield at least
        // that amount; any positive slippage is refunded so only the offer amount is bridged.
        uint256 receivedAmount = _depositAndSwap(
            _bridgeData.transactionId,
            offerAmount,
            _swapData,
            payable(_paxosData.refundRecipient),
            _paxosData.nativeFee
        );

        if (receivedAmount > offerAmount) {
            LibAsset.transferAsset(
                _bridgeData.sendingAssetId,
                payable(_paxosData.refundRecipient),
                receivedAmount - offerAmount
            );
        }

        _startBridge(_bridgeData, _paxosData);
    }

    /// Internal Methods ///

    /// @dev Ensures bridgeData and the signed quote agree on same-chain vs cross-chain,
    ///      and that a same-chain order carries no native fee.
    /// @param _bridgeData The core information needed for bridging
    /// @param _paxosData Data specific to Paxos Transit
    function _validateSameChainMode(
        ILiFi.BridgeData memory _bridgeData,
        PaxosTransitData calldata _paxosData
    ) internal view {
        // The station treats destEID == its own EID as a same-chain order: queued locally with no
        // LayerZero message, and it reverts if any native value is attached.
        bool isSameChain = _bridgeData.destinationChainId == block.chainid;
        if (
            isSameChain !=
            (_paxosData.quote.route.destEID == PAXOS_TRANSIT_THIS_CHAIN_EID)
        ) {
            revert InformationMismatch();
        }
        if (isSameChain && _paxosData.nativeFee != 0) {
            revert InvalidCallData();
        }
    }

    /// @dev Contains the business logic for bridging via Paxos Transit
    /// @param _bridgeData The core information needed for bridging
    /// @param _paxosData Data specific to Paxos Transit
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        PaxosTransitData calldata _paxosData
    ) internal {
        IPaxosTransit.Quote calldata quote = _paxosData.quote;

        // Ensure the on-chain bridgeData matches the Paxos-signed quote so we never bridge a
        // different asset or receiver than was authorized, and our volume stays attributed.
        // The amount needs no check here: both entrypoints validate minAmount == offerAmount.
        // NOTE: beyond same-chain vs cross-chain (_validateSameChainMode), the routing (quote.route.destEID)
        // and the destination asset (quote.route.wantAsset) are intentionally NOT cross-checked
        // against _bridgeData.destinationChainId. Funds always follow the Paxos-signed quote, so
        // these are trusted from the LI.FI-backend-generated, Paxos-signed calldata (same trust
        // model as AcrossFacetV4's outputAmount). Only use backend-generated calldata.
        if (
            _bridgeData.sendingAssetId != quote.route.offerAsset ||
            _bridgeData.receiver != quote.receiver ||
            quote.distributorCode != LIFI_DISTRIBUTOR_CODE
        ) {
            revert InformationMismatch();
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(TRANSIT_STATION),
            _bridgeData.minAmount
        );

        TRANSIT_STATION.submitOrder{ value: _paxosData.nativeFee }(
            quote,
            _paxosData.signature
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
