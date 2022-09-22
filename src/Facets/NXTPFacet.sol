// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ITransactionManager } from "../Interfaces/ITransactionManager.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InvalidFallbackAddress } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title NXTP (Connext) Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through NXTP (Connext)
contract NXTPFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Errors ///
    error InvariantDataMismatch();

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
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
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
    ) external payable containsSourceSwaps(_bridgeData) validateBridgeData(_bridgeData) nonReentrant {
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

    /// @notice Completes a cross-chain transaction on the receiving chain using the NXTP protocol.
    /// @param _bridgeData the core information needed for bridging
    /// @param assetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    /// @param amount number of tokens received
    function completeBridgeTokensViaNXTP(
        ILiFi.BridgeData memory _bridgeData,
        address assetId,
        address receiver,
        uint256 amount
    ) external payable nonReentrant {
        LibAsset.depositAsset(assetId, amount);
        LibAsset.transferAsset(assetId, payable(receiver), amount);
        emit LiFiTransferCompleted(_bridgeData.transactionId, assetId, receiver, amount, block.timestamp);
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    ///         on the receiving chain using the NXTP protocol.
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData array of data needed for swaps
    /// @param finalAssetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaNXTP(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        address finalAssetId,
        address receiver
    ) external payable nonReentrant {
        uint256 swapBalance = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(receiver)
        );
        LibAsset.transferAsset(finalAssetId, payable(receiver), swapBalance);
        emit LiFiTransferCompleted(_bridgeData.transactionId, finalAssetId, receiver, swapBalance, block.timestamp);
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
            revert InvariantDataMismatch();
        }
        if (_invariantData.receivingAddress != _bridgeData.receiver) {
            revert InvariantDataMismatch();
        }
        if (_invariantData.receivingChainId != _bridgeData.destinationChainId) {
            revert InvariantDataMismatch();
        }
    }
}
