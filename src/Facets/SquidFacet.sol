// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISquidRouter } from "../Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "../Interfaces/ISquidMulticall.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title Squid Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Squid Router
contract SquidFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Types ///

    enum RouteType {
        BridgeCall,
        CallBridge,
        CallBridgeCall
    }

    /// @dev Contains the data needed for bridging via Squid squidRouter
    /// @param RouteType the type of route to use
    /// @param destinationChain the chain to bridge tokens to
    /// @param bridgedTokenSymbol the symbol of the bridged token
    /// @param sourceCalls the calls to make on the source chain
    /// @param destinationCalls the calls to make on the destination chain
    /// @param fee the fee to pay
    /// @param forecallEnabled whether or not to forecall
    struct SquidData {
        RouteType routeType;
        string destinationChain;
        string bridgedTokenSymbol;
        ISquidMulticall.Call[] sourceCalls;
        ISquidMulticall.Call[] destinationCalls;
        uint256 fee;
        bool forecallEnabled;
    }

    /// State ///
    ISquidRouter public immutable squidRouter;

    /// Constructor ///
    constructor(ISquidRouter _squidRouter) {
        squidRouter = _squidRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function startBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
    {
        if (
            (_squidData.sourceCalls.length > 0) != _bridgeData.hasSourceSwaps
        ) {
            revert InformationMismatch();
        }

        if (
            (_squidData.destinationCalls.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _squidData);
    }

    /// @notice Swaps and bridges tokens via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _squidData data specific to Squid Router
    function swapAndStartBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SquidData memory _squidData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (
            (_squidData.destinationCalls.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _squidData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Squid Router
    /// @param _bridgeData the core information needed for bridging
    /// @param _squidData data specific to Squid Router
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SquidData memory _squidData
    ) internal {
        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);
        bool isNative = LibAsset.isNativeAsset(address(sendingAssetId));

        uint256 msgValue = _squidData.fee;
        if (isNative) {
            msgValue += _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                sendingAssetId,
                address(squidRouter),
                _bridgeData.minAmount
            );
        }

        if (_squidData.routeType == RouteType.BridgeCall) {
            squidRouter.bridgeCall{ value: msgValue }(
                _squidData.destinationChain,
                _squidData.bridgedTokenSymbol,
                _bridgeData.minAmount,
                _squidData.destinationCalls,
                _bridgeData.receiver,
                _squidData.forecallEnabled
            );
        } else if (_squidData.routeType == RouteType.CallBridge) {
            squidRouter.callBridge{ value: msgValue }(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _squidData.destinationChain,
                Strings.toHexString(uint160(_bridgeData.receiver), 20),
                _squidData.bridgedTokenSymbol,
                _squidData.sourceCalls
            );
        } else if (_squidData.routeType == RouteType.CallBridgeCall) {
            squidRouter.callBridgeCall{ value: msgValue }(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _squidData.destinationChain,
                _squidData.bridgedTokenSymbol,
                _squidData.sourceCalls,
                _squidData.destinationCalls,
                _bridgeData.receiver,
                _squidData.forecallEnabled
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
