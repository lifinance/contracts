// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hop Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Types ///
    struct HopData {
        address bridge;
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHop(ILiFi.BridgeData memory _bridgeData, HopData calldata _hopData)
        external
        payable
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _hopData, false);
    }

    /// @notice Performs a swap before bridging via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHop(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData memory _hopData
    ) external payable validateBridgeData(_bridgeData) nonReentrant {
        LibAsset.depositAssets(_swapData);
        if (!LibAsset.isNativeAsset(address(_bridgeData.sendingAssetId)) && msg.value != 0) revert NativeValueWithERC();
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _hopData, true);
    }

    /// private Methods ///

    /// @dev Contains the business logic for the bridge via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        HopData memory _hopData,
        bool _hasSourceSwaps
    ) private {
        // Do HOP stuff
        if (block.chainid == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        address sendingAssetId = _bridgeData.sendingAssetId;
        // Give Hop approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), _hopData.bridge, _bridgeData.minAmount);

        uint256 value = LibAsset.isNativeAsset(address(sendingAssetId)) ? _bridgeData.minAmount : 0;

        if (block.chainid == 1) {
            // Ethereum L1
            IHopBridge(_hopData.bridge).sendToL2{ value: value }(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline,
                address(0),
                0
            );
        } else {
            // L2
            // solhint-disable-next-line check-send-result
            IHopBridge(_hopData.bridge).swapAndSend{ value: value }(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.bonderFee,
                _hopData.amountOutMin,
                _hopData.deadline,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
