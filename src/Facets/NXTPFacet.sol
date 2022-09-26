// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

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
contract NXTPFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Errors ///
    error InvariantDataMismatch(string message);

    /// Types ///
    struct NXTPData {
        address nxtpTxManager;
        ITransactionManager.InvariantTransactionData invariantData;
        uint256 expiry;
        bytes encryptedCallData;
        bytes encodedBid;
        bytes bidSignature;
        bytes encodedMeta;
    }

    /// External Methods ///

    /// @notice This function starts a cross-chain transaction using the NXTP protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _nxtpData data needed to complete an NXTP cross-chain transaction
    function startBridgeTokensViaNXTP(ILiFi.BridgeData memory _bridgeData, NXTPData calldata _nxtpData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        if (hasDestinationCall(_nxtpData) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }
        validateInvariantData(_nxtpData.invariantData, _bridgeData);
        LibAsset.depositAsset(_nxtpData.invariantData.sendingAssetId, _bridgeData.minAmount);
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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        if (hasDestinationCall(_nxtpData) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }

        validateInvariantData(_nxtpData.invariantData, _bridgeData);
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
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
    function _startBridge(ILiFi.BridgeData memory _bridgeData, NXTPData memory _nxtpData) private {
        ITransactionManager txManager = ITransactionManager(_nxtpData.nxtpTxManager);
        IERC20 sendingAssetId = IERC20(_nxtpData.invariantData.sendingAssetId);
        // Give Connext approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), _nxtpData.nxtpTxManager, _bridgeData.minAmount);

        {
            address sendingChainFallback = _nxtpData.invariantData.sendingChainFallback;
            address receivingAddress = _nxtpData.invariantData.receivingAddress;

            if (LibUtil.isZeroAddress(sendingChainFallback)) {
                revert InvalidFallbackAddress();
            }
            if (LibUtil.isZeroAddress(receivingAddress)) {
                revert InvalidReceiver();
            }
        }

        // Initiate bridge transaction on sending chain
        txManager.prepare{ value: LibAsset.isNativeAsset(address(sendingAssetId)) ? _bridgeData.minAmount : 0 }(
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
        if (_invariantData.receivingChainId != _bridgeData.destinationChainId) {
            revert InvariantDataMismatch("receivingChainId");
        }
    }

    function hasDestinationCall(NXTPData memory _nxtpData) private pure returns (bool) {
        return _nxtpData.encryptedCallData.length > 0;
    }
}
