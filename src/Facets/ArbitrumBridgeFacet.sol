// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGatewayRouter } from "../Interfaces/IGatewayRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { IArbitrumInbox } from "../Interfaces/IArbitrumInbox.sol";

/// @title Arbitrum Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Arbitrum Bridge
contract ArbitrumBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///
    uint64 internal constant ARB_CHAIN_ID = 42161;

    struct BridgeData {
        address assetId;
        uint256 amount;
        address receiver;
        address inbox;
        address gatewayRouter;
        address tokenRouter;
        uint256 maxSubmissionCost;
        uint256 maxGas;
        uint256 maxGasPrice;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Arbitrum Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data for gateway router address, asset id and amount
    function startBridgeTokensViaArbitrumBridge(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        LibAsset.depositAsset(_bridgeData.assetId, _bridgeData.amount);
        _startBridge(_lifiData, _bridgeData, _bridgeData.amount, false, msg.value);
    }

    /// @notice Performs a swap before bridging via Arbitrum Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data for gateway router address, asset id and amount
    function swapAndStartBridgeTokensViaArbitrumBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData calldata _bridgeData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        uint256 ethBalance = address(this).balance - msg.value;
        uint256 amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        ethBalance = address(this).balance - ethBalance;
        _startBridge(_lifiData, _bridgeData, amount, true, ethBalance);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Arbitrum Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data for gateway router address, asset id and amount
    /// @param _amount Amount to bridge
    /// @param _hasSourceSwap Did swap on sending chain
    /// @param _receivedEther Amount of ether received from
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        uint256 _amount,
        bool _hasSourceSwap,
        uint256 _receivedEther
    ) private {
        uint256 cost = _bridgeData.maxSubmissionCost + _bridgeData.maxGas * _bridgeData.maxGasPrice;
        bool isNativeTransfer = LibAsset.isNativeAsset(_bridgeData.assetId);

        {
            uint256 requiredEther = isNativeTransfer ? cost + _amount : cost;
            if (_receivedEther < requiredEther) {
                revert InvalidAmount();
            }
        }

        if (isNativeTransfer) {
            _startNativeBridge(_bridgeData, _amount, cost);
        } else {
            _startTokenBridge(_bridgeData, _amount, cost);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "arbitrum",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _bridgeData.assetId,
            _lifiData.receivingAssetId,
            _bridgeData.receiver,
            _bridgeData.amount,
            ARB_CHAIN_ID,
            _hasSourceSwap,
            false
        );
    }

    function _startTokenBridge(
        BridgeData calldata _bridgeData,
        uint256 amount,
        uint256 cost
    ) private {
        IGatewayRouter gatewayRouter = IGatewayRouter(_bridgeData.gatewayRouter);
        LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.tokenRouter, amount);
        gatewayRouter.outboundTransfer{ value: cost }(
            _bridgeData.assetId,
            _bridgeData.receiver,
            amount,
            _bridgeData.maxGas,
            _bridgeData.maxGasPrice,
            abi.encode(_bridgeData.maxSubmissionCost, "")
        );
    }

    function _startNativeBridge(
        BridgeData calldata _bridgeData,
        uint256 amount,
        uint256 cost
    ) private {
        if (msg.sender != _bridgeData.receiver) {
            revert InvalidReceiver();
        }
        IArbitrumInbox(_bridgeData.inbox).depositEth{ value: amount + cost }();
    }
}
