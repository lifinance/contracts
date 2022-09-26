// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IL1StandardBridge } from "../Interfaces/IL1StandardBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Optimism Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Optimism Bridge
contract OptimismBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
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
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _optimismData);
    }

    /// @notice Performs a swap before bridging via Optimism Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    function swapAndStartBridgeTokensViaOptimismBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        OptimismData calldata _optimismData
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
        _startBridge(_bridgeData, _optimismData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Optimism Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, OptimismData calldata _optimismData) private {
        IL1StandardBridge bridge = IL1StandardBridge(_optimismData.bridge);

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            bridge.depositETHTo{ value: _bridgeData.minAmount }(_bridgeData.receiver, _optimismData.l2Gas, "");
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _optimismData.bridge, _bridgeData.minAmount);

            if (_optimismData.isSynthetix) {
                bridge.depositTo(_bridgeData.receiver, _bridgeData.minAmount);
            } else {
                bridge.depositERC20To(
                    _bridgeData.sendingAssetId,
                    _optimismData.assetIdOnL2,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _optimismData.l2Gas,
                    ""
                );
            }
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
