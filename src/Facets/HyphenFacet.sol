// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHyphenRouter } from "../Interfaces/IHyphenRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hyphen Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hyphen
contract HyphenFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the router on the source chain.
    IHyphenRouter private immutable router;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the router on the source chain.
    constructor(IHyphenRouter _router) {
        router = _router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Hyphen
    /// @param _bridgeData the core information needed for bridging
    function startBridgeTokensViaHyphen(ILiFi.BridgeData memory _bridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via Hyphen
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaHyphen(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
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

    /// @dev Contains the business logic for the bridge via Hyphen
    /// @param _bridgeData the core information needed for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Give the Hyphen router approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(router),
                _bridgeData.minAmount
            );

            router.depositErc20(
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                "LIFI"
            );
        } else {
            router.depositNative{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _bridgeData.destinationChainId,
                "LIFI"
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
