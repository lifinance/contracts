// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ServiceFeeCollector } from "../Periphery/ServiceFeeCollector.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InformationMismatch, InvalidConfig, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";

/// @title LIFuel Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging gas through LIFuel
contract LIFuelFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///
    string internal constant FEE_COLLECTOR_NAME = "ServiceFeeCollector";

    /// External Methods ///

    /// @notice Bridges tokens via LIFuel Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    function startBridgeTokensViaLIFuel(ILiFi.BridgeData memory _bridgeData)
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
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via LIFuel Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaLIFuel(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
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

        _startBridge(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via LIFuel Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        ServiceFeeCollector serviceFeeCollector = ServiceFeeCollector(
            LibMappings.getPeripheryRegistryMappings().contracts[
                FEE_COLLECTOR_NAME
            ]
        );

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            serviceFeeCollector.collectNativeGasFees{
                value: _bridgeData.minAmount
            }(_bridgeData.destinationChainId, _bridgeData.receiver);
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(serviceFeeCollector),
                _bridgeData.minAmount
            );

            serviceFeeCollector.collectTokenGasFees(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _bridgeData.destinationChainId,
                _bridgeData.receiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
