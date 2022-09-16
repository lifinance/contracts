// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title Hop Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    /// Types ///
    struct HopData {
        string asset;
        address sendingAssetAddress;
        address bridge;
        address recipient;
        uint256 toChainId;
        uint256 amount;
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hop Protocol
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHop(LiFiData calldata _lifiData, HopData calldata _hopData)
        external
        payable
        nonReentrant
    {
        if (LibUtil.isZeroAddress(_hopData.recipient)) {
            revert InvalidReceiver();
        }
        if (_hopData.amount == 0) {
            revert InvalidAmount();
        }

        LibAsset.depositAsset(_hopData.sendingAssetAddress, _hopData.amount);
        _startBridge(_lifiData, _hopData, false);
    }

    /// @notice Performs a swap before bridging via Hop Protocol
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHop(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        HopData memory _hopData
    ) external payable nonReentrant {
        if (LibUtil.isZeroAddress(_hopData.recipient)) {
            revert InvalidReceiver();
        }
        if (!LibAsset.isNativeAsset(address(_lifiData.sendingAssetId)) && msg.value != 0) revert NativeValueWithERC();
        _hopData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _hopData, true);
    }

    /// private Methods ///

    /// @dev Contains the business logic for the bridge via Hop Protocol
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _hopData data specific to Hop Protocol
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata _lifiData,
        HopData memory _hopData,
        bool _hasSourceSwaps
    ) private {
        // Do HOP stuff
        if (block.chainid == _hopData.toChainId) revert CannotBridgeToSameNetwork();

        address sendingAssetId = _hopData.sendingAssetAddress;
        // Give Hop approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), _hopData.bridge, _hopData.amount);

        uint256 value = LibAsset.isNativeAsset(address(sendingAssetId)) ? _hopData.amount : 0;

        if (block.chainid == 1) {
            // Ethereum L1
            IHopBridge(_hopData.bridge).sendToL2{ value: value }(
                _hopData.toChainId,
                _hopData.recipient,
                _hopData.amount,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline,
                address(0),
                0
            );
        } else {
            // L2
            // solhint-disable-next-line check-send-result
            IHopBridge(_hopData.bridge).swapAndSend{ value: value }(
                _hopData.toChainId,
                _hopData.recipient,
                _hopData.amount,
                _hopData.bonderFee,
                _hopData.amountOutMin,
                _hopData.deadline,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline
            );
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "hop",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _hopData.sendingAssetAddress,
            _lifiData.receivingAssetId,
            _hopData.recipient,
            _hopData.amount,
            _hopData.toChainId,
            _hasSourceSwaps,
            false
        );
    }
}
