// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRoninBridgeGateway } from "../Interfaces/IRoninBridgeGateway.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Ronin Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Ronin Bridge
/// @custom:version 1.0.0
contract RoninBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the gateway on the source chain.
    IRoninBridgeGateway private immutable gateway;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _gateway The contract address of the gateway on the source chain.
    constructor(IRoninBridgeGateway _gateway) {
        gateway = _gateway;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Ronin Bridge
    /// @param _bridgeData Data containing core information for bridging
    function startBridgeTokensViaRoninBridge(
        ILiFi.BridgeData memory _bridgeData
    )
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

    /// @notice Performs a swap before bridging via Ronin Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaRoninBridge(
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

    /// @dev Contains the business logic for the bridge via Ronin Bridge
    /// @param _bridgeData Data containing core information for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        IRoninBridgeGateway.Request memory request = IRoninBridgeGateway
            .Request(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                IRoninBridgeGateway.Info(
                    IRoninBridgeGateway.Standard.ERC20,
                    0,
                    _bridgeData.minAmount
                )
            );

        uint256 nativeAssetAmount;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            nativeAssetAmount = _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(gateway),
                _bridgeData.minAmount
            );
        }

        gateway.requestDepositFor{ value: nativeAssetAmount }(request);

        emit LiFiTransferStarted(_bridgeData);
    }
}
