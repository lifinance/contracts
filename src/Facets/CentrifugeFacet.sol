// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICentrifugeTokenBridge } from "../Interfaces/ICentrifugeTokenBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title Centrifuge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging tokens via Centrifuge TokenBridge
/// @custom:version 1.0.0
contract CentrifugeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The Centrifuge TokenBridge contract
    ICentrifugeTokenBridge private immutable TOKEN_BRIDGE;

    /// Types ///

    /// @param receiver The receiver address on the destination chain (bytes32 for non-EVM support)
    struct CentrifugeData {
        bytes32 receiver;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _tokenBridge The address of the Centrifuge TokenBridge contract
    constructor(ICentrifugeTokenBridge _tokenBridge) {
        if (address(_tokenBridge) == address(0)) {
            revert InvalidConfig();
        }
        TOKEN_BRIDGE = _tokenBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Centrifuge
    /// @param _bridgeData The core information needed for bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function startBridgeTokensViaCentrifuge(
        ILiFi.BridgeData memory _bridgeData,
        CentrifugeData calldata _centrifugeData
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
        _startBridge(_bridgeData, _centrifugeData);
    }

    /// @notice Performs a swap before bridging via Centrifuge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function swapAndStartBridgeTokensViaCentrifuge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CentrifugeData calldata _centrifugeData
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
        _startBridge(_bridgeData, _centrifugeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Centrifuge TokenBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CentrifugeData calldata _centrifugeData
    ) private {
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(TOKEN_BRIDGE),
            _bridgeData.minAmount
        );

        TOKEN_BRIDGE.send{ value: msg.value }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _centrifugeData.receiver,
            _bridgeData.destinationChainId,
            msg.sender
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
