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

    struct BridgeData {
        address assetId;
        address assetIdOnL2;
        uint256 amount;
        address receiver;
        address bridge;
        uint32 l2Gas;
        bool isSynthetix;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Optimism Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to Optimism Bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function startBridgeTokensViaOptimismBridge(
        LiFiData calldata _lifiData,
        BridgeData calldata _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    )
        external
        payable
        nonReentrant
        validateAmount(_bridgeData.amount)
        validateReceiver(_bridgeData.receiver)
        validateMsgValue(_bridgeData.assetId, _bridgeData.amount)
        noDepositsDust(_depositData, payable(msg.sender))
        noNativeDust(payable(msg.sender))
    {
        LibAsset.depositAssets(_depositData);
        _startBridge(_lifiData, _bridgeData, false);
    }

    /// @notice Performs a swap before bridging via Optimism Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to Optimism Bridge
    /// @param _depositData a list of deposits to make to the lifi diamond
    function swapAndStartBridgeTokensViaOptimismBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData memory _bridgeData,
        LibAsset.Deposit[] calldata _depositData
    )
        external
        payable
        nonReentrant
        validateAmount(_bridgeData.amount)
        validateReceiver(_bridgeData.receiver)
        noDepositsDust(_depositData, payable(msg.sender))
        noNativeDust(payable(msg.sender))
    {
        LibAsset.depositAssets(_depositData);
        _bridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Optimism Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data specific to Optimism Bridge
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData memory _bridgeData,
        bool _hasSourceSwap
    ) private {
        IL1StandardBridge bridge = IL1StandardBridge(_bridgeData.bridge);

        if (LibAsset.isNativeAsset(_bridgeData.assetId)) {
            bridge.depositETHTo{ value: _bridgeData.amount }(_bridgeData.receiver, _bridgeData.l2Gas, "");
        } else {
            LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.bridge, _bridgeData.amount);

            if (_bridgeData.isSynthetix) {
                bridge.depositTo(_bridgeData.receiver, _bridgeData.amount);
            } else {
                bridge.depositERC20To(
                    _bridgeData.assetId,
                    _bridgeData.assetIdOnL2,
                    _bridgeData.receiver,
                    _bridgeData.amount,
                    _bridgeData.l2Gas,
                    ""
                );
            }
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "optimism",
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
