// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Relay Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Relay Protocol
/// @custom:version 1.0.0
contract RelayFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    // Receiver for native transfers
    address public immutable relayReceiver;
    address public immutable relaySolver;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example parameter
    struct RelayData {
        bytes32 requestId;
        address receivingAssetId;
        bytes signature;
    }

    /// Modifiers ///
    modifier isValidQuote(
        ILiFi.BridgeData calldata _bridgeData,
        RelayData calldata _relayData
    ) {
        // TODO: Verify the following
        // requestId bytes32
        // originChainId uint256
        // sender bytes32(address)
        // sendingAssetId bytes32(address)
        // dstChainId uint256
        // receiver bytes32(address)
        // receivingAssetId bytes32(address)
        _;
    }

    /// Constructor ///

    constructor(address _relayReceiver, address _relaySolver) {
        relayReceiver = _relayReceiver;
        relaySolver = _relaySolver;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    function startBridgeTokensViaRelay(
        ILiFi.BridgeData memory _bridgeData,
        RelayData calldata _relayData
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
        _startBridge(_bridgeData, _relayData);
    }

    /// @notice Performs a swap before bridging via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _relayData Data specific to Relay
    function swapAndStartBridgeTokensViaRelay(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        RelayData calldata _relayData
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
        _startBridge(_bridgeData, _relayData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        RelayData calldata _relayData
    ) internal {
        // check if sendingAsset is native or ERC20
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native
        } else {
            // ERC20
        }
        emit LiFiTransferStarted(_bridgeData);
    }
}
