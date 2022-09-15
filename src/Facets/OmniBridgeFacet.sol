// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IOmniBridge } from "../Interfaces/IOmniBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title OmniBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through OmniBridge
contract OmniBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct BridgeData {
        address bridge;
        address assetId;
        address receiver;
        uint256 amount;
    }

    /// External Methods ///

    /// @notice Bridges tokens via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function startBridgeTokensViaOmniBridge(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAssets(_depositData);
        _startBridge(_lifiData, _bridgeData, false);
    }

    /// @notice Performs a swap before bridging via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function swapAndStartBridgeTokensViaOmniBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData memory _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAssets(_depositData);
        _bridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via OmniBridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to OmniBridge
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData memory _bridgeData,
        bool _hasSourceSwap
    ) private {
        IOmniBridge bridge = IOmniBridge(_bridgeData.bridge);

        if (LibAsset.isNativeAsset(_bridgeData.assetId)) {
            bridge.wrapAndRelayTokens{ value: _bridgeData.amount }(_bridgeData.receiver);
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.bridge, _bridgeData.amount);

            bridge.relayTokens(_bridgeData.assetId, _bridgeData.receiver, _bridgeData.amount);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "omni",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            false
        );
    }
}
