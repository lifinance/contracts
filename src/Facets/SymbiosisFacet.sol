// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISymbiosisMetaRouter } from "../Interfaces/ISymbiosisMetaRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Symbiosis Facet
/// @author Symbiosis (https://symbiosis.finance)
/// @notice Provides functionality for bridging through Symbiosis Protocol
/// @custom:version 1.0.0
contract SymbiosisFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the Symbiosis router on the source chain
    ISymbiosisMetaRouter private immutable symbiosisMetaRouter;
    address private immutable symbiosisGateway;

    /// Types ///

    /// @notice The data specific to Symbiosis
    /// @param firstSwapCalldata The calldata for the first swap
    /// @param secondSwapCalldata The calldata for the second swap
    /// @param intermediateToken The intermediate token used for swapping
    /// @param firstDexRouter The router for the first swap
    /// @param secondDexRouter The router for the second swap
    /// @param approvedTokens The tokens approved for swapping
    /// @param callTo The bridging entrypoint
    /// @param callData The bridging calldata
    struct SymbiosisData {
        bytes firstSwapCalldata;
        bytes secondSwapCalldata;
        address intermediateToken;
        address firstDexRouter;
        address secondDexRouter;
        address[] approvedTokens;
        address callTo;
        bytes callData;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _symbiosisMetaRouter The contract address of the Symbiosis MetaRouter on the source chain.
    /// @param _symbiosisGateway The contract address of the Symbiosis Gateway on the source chain.
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway
    ) {
        symbiosisMetaRouter = _symbiosisMetaRouter;
        symbiosisGateway = _symbiosisGateway;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Symbiosis
    /// @param _bridgeData The core information needed for bridging
    /// @param _symbiosisData The data specific to Symbiosis
    function startBridgeTokensViaSymbiosis(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _symbiosisData);
    }

    /// Private Methods ///

    /// @notice Performs a swap before bridging via Symbiosis
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _symbiosisData The data specific to Symbiosis
    function swapAndStartBridgeTokensViaSymbiosis(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SymbiosisData calldata _symbiosisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        _startBridge(_bridgeData, _symbiosisData);
    }

    /// @dev Contains the business logic for the bridge via Symbiosis
    /// @param _bridgeData the core information needed for bridging
    /// @param _symbiosisData data specific to Symbiosis
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    ) internal {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 nativeAssetAmount;

        if (isNative) {
            nativeAssetAmount = _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                symbiosisGateway,
                _bridgeData.minAmount
            );
        }

        symbiosisMetaRouter.metaRoute{ value: nativeAssetAmount }(
            ISymbiosisMetaRouter.MetaRouteTransaction(
                _symbiosisData.firstSwapCalldata,
                _symbiosisData.secondSwapCalldata,
                _symbiosisData.approvedTokens,
                _symbiosisData.firstDexRouter,
                _symbiosisData.secondDexRouter,
                _bridgeData.minAmount,
                isNative,
                _symbiosisData.callTo,
                _symbiosisData.callData
            )
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
