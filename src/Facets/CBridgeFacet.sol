// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

    /// Types ///

    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    /// @param nonce A number input to guarantee uniqueness of transferId.
    ///              Can be timestamp in practice.
    struct CBridgeData {
        uint32 maxSlippage;
        uint64 nonce;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge) {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(
        ILiFi.BridgeData memory _bridgeData,
        CBridgeData calldata _cBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _cBridgeData);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _cBridgeData data specific to CBridge
    function swapAndStartBridgeTokensViaCBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CBridgeData memory _cBridgeData
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
        _startBridge(_bridgeData, _cBridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CBridgeData memory _cBridgeData
    ) private {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            cBridge.sendNative{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(cBridge),
                _bridgeData.minAmount
            );
            // solhint-disable check-send-result
            cBridge.send(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
