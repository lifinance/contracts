// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGatewayRouter } from "../Interfaces/IGatewayRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE

/// @title Arbitrum Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Arbitrum Bridge
contract ArbitrumBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice Chain id of Arbitrum.
    uint64 private constant ARB_CHAIN_ID = 42161;

    /// @notice The contract address of the gateway router on the source chain.
    IGatewayRouter private immutable gatewayRouter;

    /// @notice The contract address of the inbox on the source chain.
    IGatewayRouter private immutable inbox;

    /// Types ///

    /// @param maxSubmissionCost Max gas deducted from user's L2 balance to cover base submission fee.
    /// @param maxGas Max gas deducted from user's L2 balance to cover L2 execution.
    /// @param maxGasPrice price bid for L2 execution.
    struct ArbitrumData {
        uint256 maxSubmissionCost;
        uint256 maxGas;
        uint256 maxGasPrice;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _gatewayRouter The contract address of the gateway router on the source chain.
    /// @param _inbox The contract address of the inbox on the source chain.
    constructor(IGatewayRouter _gatewayRouter, IGatewayRouter _inbox) {
        gatewayRouter = _gatewayRouter;
        inbox = _inbox;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    function startBridgeTokensViaArbitrumBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        preventBridgingToSameChainId(_bridgeData)
    {
        uint256 cost = _arbitrumData.maxSubmissionCost + _arbitrumData.maxGas * _arbitrumData.maxGasPrice;
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _arbitrumData, cost, msg.value);
    }

    /// @notice Performs a swap before bridging via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    function swapAndStartBridgeTokensViaArbitrumBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ArbitrumData calldata _arbitrumData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        preventBridgingToSameChainId(_bridgeData)
    {
        uint256 cost = _arbitrumData.maxSubmissionCost + _arbitrumData.maxGas * _arbitrumData.maxGasPrice;

        uint256 ethBalance = address(this).balance - msg.value;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            cost
        );

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            _bridgeData.minAmount -= cost;
        }

        _startBridge(_bridgeData, _arbitrumData, cost, address(this).balance - ethBalance);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    /// @param _cost Additional amount of native asset for the fee
    /// @param _receivedEther Amount of ether received from
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData,
        uint256 _cost,
        uint256 _receivedEther
    ) private validateBridgeData(_bridgeData) {
        bool isNativeTransfer = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);

        uint256 requiredEther = isNativeTransfer ? _cost + _bridgeData.minAmount : _cost;
        if (_receivedEther < requiredEther) {
            revert InvalidAmount();
        }

        if (isNativeTransfer) {
            _startNativeBridge(_bridgeData, _arbitrumData, _cost);
        } else {
            _startTokenBridge(_bridgeData, _arbitrumData, _cost);
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    function _startTokenBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData,
        uint256 cost
    ) private {
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            gatewayRouter.getGateway(_bridgeData.sendingAssetId),
            _bridgeData.minAmount
        );
        gatewayRouter.outboundTransfer{ value: cost }(
            _bridgeData.sendingAssetId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _arbitrumData.maxGas,
            _arbitrumData.maxGasPrice,
            abi.encode(_arbitrumData.maxSubmissionCost, "")
        );
    }

    function _startNativeBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData,
        uint256 cost
    ) private {
        inbox.unsafeCreateRetryableTicket{ value: _bridgeData.minAmount + cost }(
            _bridgeData.receiver,
            _bridgeData.minAmount, // l2CallValue
            _arbitrumData.maxSubmissionCost,
            _bridgeData.receiver, // excessFeeRefundAddress
            _bridgeData.receiver, // callValueRefundAddress
            _arbitrumData.maxGas,
            _arbitrumData.maxGasPrice,
            ""
        );
    }
}
