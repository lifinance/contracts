// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidReceiver, InvalidAmount, TokenAddressIsZero } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Amarok Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Connext Amarok
contract AmarokFacet is ILiFi, SwapperV2, ReentrancyGuard {
    uint32 immutable srcChainDomain;

    /// Types ///

    struct BridgeData {
        address connextHandler;
        address assetId;
        uint32 dstChainDomain;
        address receiver;
        uint256 amount;
        bytes callData;
        bool forceSlow;
        bool receiveLocal;
        address callback;
        uint256 callbackFee;
        uint256 relayerFee;
        uint256 slippageTol;
        uint256 originMinOut;
    }

    constructor(uint32 _srcChainDomain) {
        srcChainDomain = _srcChainDomain;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Amarok
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function startBridgeTokensViaAmarok(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.assetId == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.depositAssets(_depositData);
        _startBridge(_lifiData, _bridgeData, false);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function swapAndStartBridgeTokensViaAmarok(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData memory _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.assetId == address(0)) {
            revert TokenAddressIsZero();
        }

        LibAsset.depositAssets(_depositData);
        _bridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, true);
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
        if (!LibAsset.isNativeAsset(assetId)) {
            LibAsset.depositAsset(assetId, amount);
        }
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
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData memory _bridgeData,
        bool _hasSourceSwap
    ) private {
        IConnextHandler.XCallArgs memory xcallArgs = IConnextHandler.XCallArgs({
            params: IConnextHandler.CallParams({
                to: _bridgeData.receiver,
                callData: _bridgeData.callData,
                originDomain: srcChainDomain,
                destinationDomain: _bridgeData.dstChainDomain,
                agent: _bridgeData.receiver,
                recovery: msg.sender,
                forceSlow: _bridgeData.forceSlow,
                receiveLocal: _bridgeData.receiveLocal,
                callback: _bridgeData.callback,
                callbackFee: _bridgeData.callbackFee,
                relayerFee: _bridgeData.relayerFee,
                slippageTol: _bridgeData.slippageTol
            }),
            transactingAsset: _bridgeData.assetId,
            transactingAmount: _bridgeData.amount,
            originMinOut: _bridgeData.originMinOut
        });

        LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.connextHandler, _bridgeData.amount);
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
