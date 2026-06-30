// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IPaxosTransit } from "../Interfaces/IPaxosTransit.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch, InvalidConfig } from "../Errors/GenericErrors.sol";

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
    struct PaxosTransitData {
        IPaxosTransit.Quote quote;
        bytes signature;
        uint256 nativeFee;
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
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // The Paxos quote locks an exact offerAmount, so the swap must yield at least
        // that amount; any positive slippage is refunded so only the offer amount is bridged.
        uint256 receivedAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _paxosData.quote.offerAmount,
            _swapData,
            payable(msg.sender),
            _paxosData.nativeFee
        );

        if (receivedAmount > _paxosData.quote.offerAmount) {
            LibAsset.transferAsset(
                _bridgeData.sendingAssetId,
                payable(msg.sender),
                receivedAmount - _paxosData.quote.offerAmount
            );
        }

        _bridgeData.minAmount = _paxosData.quote.offerAmount;
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
        // different asset, amount or receiver than was authorized, and our volume stays attributed.
        if (
            _bridgeData.sendingAssetId != quote.route.offerAsset ||
            _bridgeData.minAmount != quote.offerAmount ||
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
