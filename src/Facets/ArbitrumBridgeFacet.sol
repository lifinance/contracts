// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGatewayRouter } from "../Interfaces/IGatewayRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver, InvalidFee } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { IArbitrumInbox } from "../Interfaces/IArbitrumInbox.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Arbitrum Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Arbitrum Bridge
contract ArbitrumBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Types ///
    uint64 internal constant ARB_CHAIN_ID = 42161;

    struct ArbitrumData {
        address inbox;
        address gatewayRouter;
        address tokenRouter;
        uint256 maxSubmissionCost;
        uint256 maxGas;
        uint256 maxGasPrice;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    function startBridgeTokensViaArbitrumBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData
    ) external payable doesNotContainSourceSwaps(_bridgeData) validateBridgeData(_bridgeData) nonReentrant {
        uint256 cost = _arbitrumData.maxSubmissionCost + _arbitrumData.maxGas * _arbitrumData.maxGasPrice;
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _arbitrumData, _bridgeData.minAmount, cost);
    }

    /// @notice Performs a swap before bridging via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    function swapAndStartBridgeTokensViaArbitrumBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ArbitrumData calldata _arbitrumData
    ) external payable containsSourceSwaps(_bridgeData) validateBridgeData(_bridgeData) nonReentrant {
        LibAsset.depositAssets(_swapData);
        uint256 amount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        uint256 cost = _arbitrumData.maxSubmissionCost + _arbitrumData.maxGas * _arbitrumData.maxGasPrice;
        _startBridge(_bridgeData, _arbitrumData, amount, cost);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Arbitrum Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _arbitrumData Data for gateway router address, asset id and amount
    /// @param _amount Amount to bridge
    /// @param _cost Additional amount of native asset for the fee
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ArbitrumData calldata _arbitrumData,
        uint256 _amount,
        uint256 _cost
    ) private validateBridgeData(_bridgeData) {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            if (msg.sender != _bridgeData.receiver) {
                revert InvalidReceiver();
            }
            IArbitrumInbox(_arbitrumData.inbox).depositEth{ value: _amount }();
        } else {
            if (msg.value != _cost) {
                revert InvalidFee();
            }
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _arbitrumData.tokenRouter, _amount);
            IGatewayRouter(_arbitrumData.gatewayRouter).outboundTransfer{ value: _cost }(
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _amount,
                _arbitrumData.maxGas,
                _arbitrumData.maxGasPrice,
                abi.encode(_arbitrumData.maxSubmissionCost, "")
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
