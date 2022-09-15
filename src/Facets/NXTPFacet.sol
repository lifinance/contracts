// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ITransactionManager } from "../Interfaces/ITransactionManager.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InvalidFallbackAddress } from "../Errors/GenericErrors.sol";

/// @title NXTP (Connext) Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through NXTP (Connext)
contract NXTPFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///
    struct NXTPData {
        address nxtpTxManager;
        ITransactionManager.InvariantTransactionData invariantData;
        uint256 amount;
        uint256 expiry;
        bytes encryptedCallData;
        bytes encodedBid;
        bytes bidSignature;
        bytes encodedMeta;
    }

    /// External Methods ///

    /// @notice This function starts a cross-chain transaction using the NXTP protocol
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _nxtpData data needed to complete an NXTP cross-chain transaction
    /// @param _depositData a list of deposits to make to the lifi diamond
    function startBridgeTokensViaNXTP(
        LiFiData calldata _lifiData,
        NXTPData calldata _nxtpData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        LibAsset.depositAssets(_depositData);
        _startBridge(_nxtpData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "nxtp",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _nxtpData.invariantData.sendingAssetId,
            _lifiData.receivingAssetId,
            _nxtpData.invariantData.receivingAddress,
            _nxtpData.amount,
            _nxtpData.invariantData.receivingChainId,
            false,
            !LibUtil.isZeroAddress(_nxtpData.invariantData.callTo)
        );
    }

    /// @notice This function performs a swap or multiple swaps and then starts a cross-chain transaction
    ///         using the NXTP protocol.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param _nxtpData data needed to complete an NXTP cross-chain transaction
    /// @param _depositData a list of deposits to make to the lifi diamond
    function swapAndStartBridgeTokensViaNXTP(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        NXTPData memory _nxtpData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        LibAsset.depositAssets(_depositData);
        _nxtpData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_nxtpData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "nxtp",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _nxtpData.invariantData.receivingAddress,
            _swapData[0].fromAmount,
            _nxtpData.invariantData.receivingChainId,
            true,
            !LibUtil.isZeroAddress(_nxtpData.invariantData.callTo)
        );
    }

    /// @notice Completes a cross-chain transaction on the receiving chain using the NXTP protocol.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param assetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    /// @param amount number of tokens received
    function completeBridgeTokensViaNXTP(
        LiFiData calldata _lifiData,
        address assetId,
        address receiver,
        uint256 amount
    ) external payable nonReentrant {
        LibAsset.depositAsset(assetId, amount);
        LibAsset.transferAsset(assetId, payable(receiver), amount);
        emit LiFiTransferCompleted(_lifiData.transactionId, assetId, receiver, amount, block.timestamp);
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    ///         on the receiving chain using the NXTP protocol.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param finalAssetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaNXTP(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address finalAssetId,
        address receiver
    ) external payable nonReentrant {
        uint256 swapBalance = _executeAndCheckSwaps(_lifiData, _swapData, payable(receiver));
        LibAsset.transferAsset(finalAssetId, payable(receiver), swapBalance);
        emit LiFiTransferCompleted(_lifiData.transactionId, finalAssetId, receiver, swapBalance, block.timestamp);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via NXTP
    /// @param _nxtpData data specific to NXTP
    function _startBridge(NXTPData memory _nxtpData) private {
        ITransactionManager txManager = ITransactionManager(_nxtpData.nxtpTxManager);
        IERC20 sendingAssetId = IERC20(_nxtpData.invariantData.sendingAssetId);
        // Give Connext approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), _nxtpData.nxtpTxManager, _nxtpData.amount);

        uint256 value = LibAsset.isNativeAsset(address(sendingAssetId)) ? _nxtpData.amount : 0;
        address sendingChainFallback = _nxtpData.invariantData.sendingChainFallback;
        address receivingAddress = _nxtpData.invariantData.receivingAddress;

        if (LibUtil.isZeroAddress(sendingChainFallback)) {
            revert InvalidFallbackAddress();
        }
        if (LibUtil.isZeroAddress(receivingAddress)) {
            revert InvalidReceiver();
        }

        // Initiate bridge transaction on sending chain
        txManager.prepare{ value: value }(
            ITransactionManager.PrepareArgs(
                _nxtpData.invariantData,
                _nxtpData.amount,
                _nxtpData.expiry,
                _nxtpData.encryptedCallData,
                _nxtpData.encodedBid,
                _nxtpData.bidSignature,
                _nxtpData.encodedMeta
            )
        );
    }
}
