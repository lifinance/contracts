// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISynapseRouter } from "../Interfaces/ISynapseRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title SynapseBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through SynapseBridge
/// @custom:version 1.0.0
contract SynapseBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address internal constant NETH_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice The contract address of the SynapseRouter on the source chain.
    ISynapseRouter private immutable synapseRouter;

    /// Types ///

    /// @param originQuery Origin swap query. Empty struct indicates no swap is required.
    /// @param destQuery Destination swap query. Empty struct indicates no swap is required.
    struct SynapseData {
        ISynapseRouter.SwapQuery originQuery;
        ISynapseRouter.SwapQuery destQuery;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _synapseRouter The contract address of the SynapseRouter on the source chain.
    constructor(ISynapseRouter _synapseRouter) {
        synapseRouter = _synapseRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Synapse Bridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _synapseData data specific to Synapse Bridge
    function startBridgeTokensViaSynapseBridge(
        ILiFi.BridgeData calldata _bridgeData,
        SynapseData calldata _synapseData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _synapseData);
    }

    /// @notice Performs a swap before bridging via Synapse Bridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _synapseData data specific to Synapse Bridge
    function swapAndStartBridgeTokensViaSynapseBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SynapseData calldata _synapseData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        _startBridge(_bridgeData, _synapseData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Synapse Bridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _synapseData data specific to Synapse Bridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SynapseData calldata _synapseData
    ) internal {
        uint256 nativeAssetAmount;
        address sendingAssetId = _bridgeData.sendingAssetId;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            nativeAssetAmount = _bridgeData.minAmount;
            sendingAssetId = NETH_ADDRESS;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(synapseRouter),
                _bridgeData.minAmount
            );
        }

        synapseRouter.bridge{ value: nativeAssetAmount }(
            _bridgeData.receiver,
            _bridgeData.destinationChainId,
            sendingAssetId,
            _bridgeData.minAmount,
            _synapseData.originQuery,
            _synapseData.destQuery
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
