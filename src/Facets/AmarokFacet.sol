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
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.assetId == address(0)) {
            revert TokenAddressIsZero();
        }

        uint256 amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, amount, true);
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
            transactingAmount: _amount,
            originMinOut: _bridgeData.originMinOut
        });

        LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.connextHandler, _amount);
        IConnextHandler(_bridgeData.connextHandler).xcall(xcallArgs);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "amarok",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _bridgeData.assetId,
            _lifiData.receivingAssetId,
            _bridgeData.receiver,
            _bridgeData.amount,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            _bridgeData.callData.length > 0
        );
    }
}
