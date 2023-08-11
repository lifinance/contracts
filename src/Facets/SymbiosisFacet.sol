// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

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
    /// @notice The contract address of the Symbiosis router on the source chain
    ISymbiosisMetaRouter private immutable symbiosisMetaRouter;
    address private immutable symbiosisGateway;

    /// Types ///
    struct SymbiosisData {
        bytes firstSwapCalldata;
        bytes secondSwapCalldata;
        address intermediateToken;
        address bridgingToken;
        address firstDexRouter;
        address secondDexRouter;
        address callTo;    // bridging entrypoint
        bytes callData;   // bridging calldata
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

        address[] memory approvedTokens = new address[](1);
        approvedTokens[0] = _bridgeData.sendingAssetId;


        symbiosisMetaRouter.metaRoute{ value: nativeAssetAmount }(
            ISymbiosisMetaRouter.MetaRouteTransaction(
                _symbiosisData.firstSwapCalldata,
                _symbiosisData.secondSwapCalldata,
                approvedTokens,
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
}
