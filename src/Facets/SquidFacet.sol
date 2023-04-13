// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISquidRouter } from "../Interfaces/ISquidRouter.sol";
import { ISquidMulticall } from "../Interfaces/ISquidMulticall.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Squid Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Squid Router
/// @custom:version 1.0.0
contract SquidFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Types ///

    enum RouteType {
        BridgeCall,
        CallBridge,
        CallBridgeCall
    }

    /// @dev Contains the data needed for bridging via Squid squidRouter
    /// @param RouteType The type of route to use
    /// @param destinationChain The chain to bridge tokens to
    /// @param bridgedTokenSymbol The symbol of the bridged token
    /// @param sourceCalls The calls to make on the source chain
    /// @param destinationCalls The calls to make on the destination chain
    /// @param fee The fee to pay
    /// @param forecallEnabled Whether or not to forecall (Squid Router's instant execution service)
    struct SquidData {
        RouteType routeType;
        string destinationChain;
        string bridgedTokenSymbol;
        ISquidMulticall.Call[] sourceCalls;
        ISquidMulticall.Call[] destinationCalls;
        uint256 fee;
        bool forecallEnabled;
    }

    /// Errors ///
    error InvalidRouteType();

    /// State ///

    ISquidRouter private immutable squidRouter;

    /// Constructor ///

    constructor(ISquidRouter _squidRouter) {
        squidRouter = _squidRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Squid Router
    /// @param _bridgeData The core information needed for bridging
    /// @param _squidData Data specific to Squid Router
    function startBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        SquidData calldata _squidData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (
            !LibAsset.isNativeAsset(address(_bridgeData.sendingAssetId)) &&
            keccak256(abi.encodePacked(_squidData.bridgedTokenSymbol)) !=
            keccak256(
                abi.encodePacked(ERC20(_bridgeData.sendingAssetId).symbol())
            )
        ) {
            revert InformationMismatch();
        }

        validateDestinationCallFlag(_bridgeData, _squidData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _squidData);
    }

    /// @notice Swaps and bridges tokens via Squid Router
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _squidData Data specific to Squid Router
    function swapAndStartBridgeTokensViaSquid(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SquidData calldata _squidData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (
            !LibAsset.isNativeAsset(address(_bridgeData.sendingAssetId)) &&
            keccak256(abi.encodePacked(_squidData.bridgedTokenSymbol)) !=
            keccak256(
                abi.encodePacked(ERC20(_bridgeData.sendingAssetId).symbol())
            )
        ) {
            revert InformationMismatch();
        }

        validateDestinationCallFlag(_bridgeData, _squidData);

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
    /// @param _bridgeData The core information needed for bridging
    /// @param _squidData Data specific to Squid Router
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SquidData calldata _squidData
    ) internal {
        uint256 msgValue = _squidData.fee;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            msgValue += _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
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
                LibBytes.toHexString(uint160(_bridgeData.receiver), 20),
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
        } else {
            revert InvalidRouteType();
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        SquidData calldata _squidData
    ) private pure {
        if (
            (_squidData.destinationCalls.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
