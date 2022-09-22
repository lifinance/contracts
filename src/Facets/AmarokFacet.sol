// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Amarok Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Connext Amarok
contract AmarokFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    uint32 immutable srcChainDomain;

    /// Types ///

    struct AmarokData {
        address connextHandler;
        uint32 dstChainDomain;
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
    /// @param _bridgeData Data containing core information for bridging
    /// @param _amarokData Data specific to bridge
    function startBridgeTokensViaAmarok(BridgeData calldata _bridgeData, AmarokData calldata _amarokData)
        external
        payable
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _amarokData, _bridgeData.minAmount);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _amarokData Data specific to bridge
    function swapAndStartBridgeTokensViaAmarok(
        BridgeData calldata _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AmarokData calldata _amarokData
    )
        external
        payable
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAssets(_swapData);
        uint256 amount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _amarokData, amount);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain using the Amarok.
    /// @param _bridgeData the core information needed for bridging
    /// @param assetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    /// @param amount number of tokens received
    function completeBridgeTokensViaAmarok(
        BridgeData calldata _bridgeData,
        address assetId,
        address receiver,
        uint256 amount
    ) external payable nonReentrant {
        LibAsset.depositAsset(assetId, amount);
        LibAsset.transferAsset(assetId, payable(receiver), amount);
        emit LiFiTransferCompleted(_bridgeData.transactionId, assetId, receiver, amount, block.timestamp);
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    ///         on the receiving chain using the Amarok protocol.
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData array of data needed for swaps
    /// @param finalAssetId token received on the receiving chain
    /// @param receiver address that will receive the tokens
    function swapAndCompleteBridgeTokensViaAmarok(
        BridgeData calldata _bridgeData,
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

    /// @dev Contains the business logic for the bridge via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _amarokData Data specific to Amarok
    /// @param _amount Amount to bridge
    function _startBridge(
        BridgeData calldata _bridgeData,
        AmarokData calldata _amarokData,
        uint256 _amount
    ) private {
        IConnextHandler.XCallArgs memory xcallArgs = IConnextHandler.XCallArgs({
            params: IConnextHandler.CallParams({
                to: _bridgeData.receiver,
                callData: _amarokData.callData,
                originDomain: srcChainDomain,
                destinationDomain: _amarokData.dstChainDomain,
                agent: _bridgeData.receiver,
                recovery: msg.sender,
                forceSlow: _amarokData.forceSlow,
                receiveLocal: _amarokData.receiveLocal,
                callback: _amarokData.callback,
                callbackFee: _amarokData.callbackFee,
                relayerFee: _amarokData.relayerFee,
                slippageTol: _amarokData.slippageTol
            }),
            transactingAsset: _bridgeData.sendingAssetId,
            transactingAmount: _amount,
            originMinOut: _amarokData.originMinOut
        });

        LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _amarokData.connextHandler, _amount);
        IConnextHandler(_amarokData.connextHandler).xcall(xcallArgs);

        emit LiFiTransferStarted(_bridgeData);
    }
}
