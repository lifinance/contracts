// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IPaxosTransit } from "../Interfaces/IPaxosTransit.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title PaxosTransitFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Paxos Transit
/// @custom:version 1.0.0
contract PaxosTransitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The Paxos Transit station contract on the source chain.
    IPaxosTransit public immutable TRANSIT_STATION;

    /// @notice The LI.FI distributor code (left-adjusted bytes32 encoding of "LIFI").
    bytes32 public constant LIFI_DISTRIBUTOR_CODE =
        0x4c49464900000000000000000000000000000000000000000000000000000000;

    /// Types ///

    /// @param quote The Paxos-signed quote describing the transit order
    /// @param signature The Paxos signature over the EIP-712 quote digest
    /// @param nativeFee The native amount forwarded to Transit to pay the LayerZero messaging fee
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

    /// Constructor ///

    /// @notice Initializes the PaxosTransitFacet
    /// @param _transitStation The address of the Paxos Transit station on the source chain
    constructor(IPaxosTransit _transitStation) {
        if (address(_transitStation) == address(0)) {
            revert InvalidConfig();
        }
        TRANSIT_STATION = _transitStation;
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
        validateBridgeData(_bridgeData)
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
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // msg.sender may be a relayer or the Permit2Proxy, so value that belongs to the
        // user (swap leftovers, positive slippage and excess native) must go to an
        // explicit refundRecipient.
        if (_paxosData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        uint256 offerAmount = _paxosData.quote.offerAmount;

        // The Paxos-signed quote locks the exact amount to bridge, so minAmount must match it
        // here too - this also extends validateBridgeData's non-zero minAmount guarantee to
        // the swap floor below.
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
        // NOTE: the routing (quote.route.destEID) and the destination asset (quote.route.wantAsset)
        // are intentionally NOT cross-checked against _bridgeData.destinationChainId. Funds always
        // follow the Paxos-signed quote, so these are trusted from the LI.FI-backend-generated,
        // Paxos-signed calldata (same trust model as AcrossFacetV4's outputAmount). Only use
        // backend-generated calldata. _bridgeData.destinationChainId is for analytics/events only.
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
