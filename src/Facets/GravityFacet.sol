// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGravityRouter } from "../Interfaces/IGravityRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Gravity Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Gravity
contract GravityFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the router on the source chain.
    IGravityRouter private immutable router;

    /// Types ///

    struct GravityData {
        string destinationAddress;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the router on the source chain.
    constructor(IGravityRouter _router) {
        router = _router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Gravity
    /// @param _bridgeData the core information needed for bridging
    function startBridgeTokensViaGravity(ILiFi.BridgeData memory _bridgeData, GravityData memory _gravityData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _gravityData);
    }

    /// @notice Performs a swap before bridging via Gravity
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaGravity(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GravityData memory _gravityData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _gravityData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Hyphen
    /// @param _bridgeData the core information needed for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData, GravityData memory _gravityData) private {
        // Give the Gravity router approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), address(router), _bridgeData.minAmount);

        router.sendToCosmos(_bridgeData.sendingAssetId, _gravityData.destinationAddress, _bridgeData.minAmount);

        emit LiFiTransferStarted(_bridgeData);
    }
}
