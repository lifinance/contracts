// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IL1StandardBridge } from "../Interfaces/IL1StandardBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Optimism Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Optimism Bridge
contract OptimismBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct OptimismData {
        address assetIdOnL2;
        address bridge;
        uint32 l2Gas;
        bool isSynthetix;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Optimism Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    function startBridgeTokensViaOptimismBridge(
        ILiFi.BridgeData memory _bridgeData,
        OptimismData calldata _optimismData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _optimismData, _bridgeData.minAmount, false);
    }

    /// @notice Performs a swap before bridging via Optimism Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    function swapAndStartBridgeTokensViaOptimismBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        OptimismData calldata _optimismData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        LibAsset.depositAssets(_swapData);
        uint256 amount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _optimismData, amount, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Optimism Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    /// @param _amount Amount to bridge
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        OptimismData calldata _optimismData,
        uint256 _amount,
        bool _hasSourceSwap
    ) private {
        IL1StandardBridge bridge = IL1StandardBridge(_optimismData.bridge);

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            bridge.depositETHTo{ value: _amount }(_bridgeData.receiver, _optimismData.l2Gas, "");
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _optimismData.bridge, _amount);

            if (_optimismData.isSynthetix) {
                bridge.depositTo(_bridgeData.receiver, _amount);
            } else {
                bridge.depositERC20To(
                    _bridgeData.sendingAssetId,
                    _optimismData.assetIdOnL2,
                    _bridgeData.receiver,
                    _amount,
                    _optimismData.l2Gas,
                    ""
                );
            }
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
