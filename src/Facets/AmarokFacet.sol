// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, TokenAddressIsZero } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Amarok Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Connext Amarok
contract AmarokFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct BridgeData {
        address connextHandler;
        address assetId;
        uint32 srcChainDomain;
        uint32 dstChainDomain;
        address receiver;
        uint256 amount;
        bytes callData;
        uint256 slippageTol;
        address tokenFallback;
        uint256 callbackFee;
        uint256 relayerFee;
    }

    /// Errors ///

    error InvalidReceiver();

    /// External Methods ///

    /// @notice Bridges tokens via Amarok
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to bridge
    function startBridgeTokensViaAmarok(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.assetId == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.depositAsset(_bridgeData.assetId, _bridgeData.amount);

        _startBridge(_lifiData, _bridgeData, _bridgeData.amount, false);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to bridge
    function swapAndStartBridgeTokensViaAmarok(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData calldata _bridgeData
    ) external nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.assetId == address(0)) {
            revert TokenAddressIsZero();
        }

        uint256 amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));

        if (amount == 0) {
            revert InvalidAmount();
        }

        _startBridge(_lifiData, _bridgeData, amount, true);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain using the Amarok.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param assetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    /// @param amount number of tokens received
    function completeBridgeTokensViaAmarok(
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
    ///         on the receiving chain using the Amarok protocol.
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param finalAssetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaAmarok(
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

    /// @dev Contains the business logic for the bridge via Amarok
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to Amarok
    /// @param _amount Amount to bridge
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        uint256 _amount,
        bool _hasSourceSwap
    ) private {
        IConnextHandler.XCallArgs memory xcallArgs = IConnextHandler.XCallArgs({
            params: IConnextHandler.CallParams({
                to: _bridgeData.receiver,
                callData: _bridgeData.callData,
                originDomain: _bridgeData.srcChainDomain,
                destinationDomain: _bridgeData.dstChainDomain,
                agent: _bridgeData.receiver,
                recovery: _bridgeData.tokenFallback,
                forceSlow: false,
                receiveLocal: false,
                callback: address(0),
                callbackFee: _bridgeData.callbackFee,
                relayerFee: _bridgeData.relayerFee,
                slippageTol: _bridgeData.slippageTol
            }),
            transactingAssetId: _bridgeData.assetId,
            amount: _amount
        });

        LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.connextHandler, _amount);
        IConnextHandler(_bridgeData.connextHandler).xcall(xcallArgs);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "amarok",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            _bridgeData.callData.length > 0
        );
    }
}
