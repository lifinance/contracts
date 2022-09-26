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
contract AmarokFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
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
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _amarokData);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _amarokData Data specific to bridge
    function swapAndStartBridgeTokensViaAmarok(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AmarokData calldata _amarokData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _amarokData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _amarokData Data specific to Amarok
    function _startBridge(BridgeData memory _bridgeData, AmarokData calldata _amarokData) private {
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
            transactingAmount: _bridgeData.minAmount,
            originMinOut: _amarokData.originMinOut
        });

        LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _amarokData.connextHandler, _bridgeData.minAmount);
        IConnextHandler(_amarokData.connextHandler).xcall(xcallArgs);

        emit LiFiTransferStarted(_bridgeData);
    }
}
