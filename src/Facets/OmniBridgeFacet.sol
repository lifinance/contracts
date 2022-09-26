// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOmniBridge } from "../Interfaces/IOmniBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title OmniBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through OmniBridge
contract OmniBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Types ///

    uint64 internal constant GNOSIS_CHAIN_ID = 100;

    struct OmniData {
        address bridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _omniData Data specific to bridge
    function startBridgeTokensViaOmniBridge(ILiFi.BridgeData memory _bridgeData, OmniData calldata _omniData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _omniData);
    }

    /// @notice Performs a swap before bridging via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _omniData Data specific to bridge
    function swapAndStartBridgeTokensViaOmniBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        OmniData calldata _omniData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _omniData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via OmniBridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _omniData Data specific to OmniBridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, OmniData calldata _omniData) private {
        IOmniBridge bridge = IOmniBridge(_omniData.bridge);
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            bridge.wrapAndRelayTokens{ value: _bridgeData.minAmount }(_bridgeData.receiver);
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _omniData.bridge, _bridgeData.minAmount);

            bridge.relayTokens(_bridgeData.sendingAssetId, _bridgeData.receiver, _bridgeData.minAmount);
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
