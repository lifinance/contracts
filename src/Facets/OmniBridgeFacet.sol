// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOmniBridge } from "../Interfaces/IOmniBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title OmniBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through OmniBridge
/// @custom:version 1.0.0
contract OmniBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the foreign omni bridge on the source chain.
    IOmniBridge private immutable foreignOmniBridge;

    /// @notice The contract address of the weth omni bridge on the source chain.
    IOmniBridge private immutable wethOmniBridge;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _foreignOmniBridge The contract address of the foreign omni bridge on the source chain.
    /// @param _wethOmniBridge The contract address of the weth omni bridge on the source chain.
    constructor(IOmniBridge _foreignOmniBridge, IOmniBridge _wethOmniBridge) {
        foreignOmniBridge = _foreignOmniBridge;
        wethOmniBridge = _wethOmniBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    function startBridgeTokensViaOmniBridge(
        ILiFi.BridgeData memory _bridgeData
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
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaOmniBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
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
        _startBridge(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            wethOmniBridge.wrapAndRelayTokens{ value: _bridgeData.minAmount }(
                _bridgeData.receiver
            );
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(foreignOmniBridge),
                _bridgeData.minAmount
            );
            foreignOmniBridge.relayTokens(
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.minAmount
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
