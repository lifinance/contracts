// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ITransactionManager } from "../Interfaces/ITransactionManager.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InformationMismatch, InvalidFallbackAddress } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title NXTP (Connext) Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through NXTP (Connext)
contract NXTPFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the transaction manager on the source chain.
    ITransactionManager private immutable txManager;

    /// Errors ///

    error InvariantDataMismatch(string message);

    /// Types ///

    struct NXTPData {
        ITransactionManager.InvariantTransactionData invariantData;
        uint256 expiry;
        bytes encryptedCallData;
        bytes encodedBid;
        bytes bidSignature;
        bytes encodedMeta;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _txManager The contract address of the transaction manager on the source chain.
    constructor(ITransactionManager _txManager) {
        txManager = _txManager;
    }

    /// External Methods ///

    /// @notice This function starts a cross-chain transaction using the NXTP protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _nxtpData data needed to complete an NXTP cross-chain transaction
    function startBridgeTokensViaNXTP(
        ILiFi.BridgeData memory _bridgeData,
        NXTPData calldata _nxtpData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (hasDestinationCall(_nxtpData) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }
        validateInvariantData(_nxtpData.invariantData, _bridgeData);
        LibAsset.depositAsset(
            _nxtpData.invariantData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _nxtpData);
    }

    /// @notice This function performs a swap or multiple swaps and then starts a cross-chain transaction
    ///         using the NXTP protocol.
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData array of data needed for swaps
    /// @param _nxtpData data needed to complete an NXTP cross-chain transaction
    function swapAndStartBridgeTokensViaNXTP(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        NXTPData calldata _nxtpData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (hasDestinationCall(_nxtpData) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }

        validateInvariantData(_nxtpData.invariantData, _bridgeData);
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _nxtpData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via NXTP
    /// @param _bridgeData the core information needed for bridging
    /// @param _nxtpData data specific to NXTP
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        NXTPData memory _nxtpData
    ) private {
        IERC20 sendingAssetId = IERC20(_nxtpData.invariantData.sendingAssetId);
        // Give Connext approval to bridge tokens
        LibAsset.maxApproveERC20(
            IERC20(sendingAssetId),
            address(txManager),
            _bridgeData.minAmount
        );

        {
            address sendingChainFallback = _nxtpData
                .invariantData
                .sendingChainFallback;
            address receivingAddress = _nxtpData
                .invariantData
                .receivingAddress;

            if (LibUtil.isZeroAddress(sendingChainFallback)) {
                revert InvalidFallbackAddress();
            }
            if (LibUtil.isZeroAddress(receivingAddress)) {
                revert InvalidReceiver();
            }
        }

        // Initiate bridge transaction on sending chain
        txManager.prepare{
            value: LibAsset.isNativeAsset(address(sendingAssetId))
                ? _bridgeData.minAmount
                : 0
        }(
            ITransactionManager.PrepareArgs(
                _nxtpData.invariantData,
                _bridgeData.minAmount,
                _nxtpData.expiry,
                _nxtpData.encryptedCallData,
                _nxtpData.encodedBid,
                _nxtpData.bidSignature,
                _nxtpData.encodedMeta
            )
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    function validateInvariantData(
        ITransactionManager.InvariantTransactionData calldata _invariantData,
        ILiFi.BridgeData memory _bridgeData
    ) private pure {
        if (_invariantData.sendingAssetId != _bridgeData.sendingAssetId) {
            revert InvariantDataMismatch("sendingAssetId");
        }
        if (_invariantData.receivingAddress != _bridgeData.receiver) {
            revert InvariantDataMismatch("receivingAddress");
        }
        if (
            _invariantData.receivingChainId != _bridgeData.destinationChainId
        ) {
            revert InvariantDataMismatch("receivingChainId");
        }
    }

    function hasDestinationCall(NXTPData memory _nxtpData)
        private
        pure
        returns (bool)
    {
        return _nxtpData.encryptedCallData.length > 0;
    }
}
