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

// import { console } from "forge-std/console.sol"; //TODO: REMOVE

/// @title Squid Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Squid Router
/// @custom:version 0.0.4
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
    /// @param destinationAddress The receiver address in dst chain format
    /// @param bridgedTokenSymbol The symbol of the to-be-bridged token
    /// @param depositAssetId The asset to be deposited on src network (input for optional Squid-internal src swaps)
    /// @param sourceCalls The calls to be made by Squid on the source chain before bridging the bridgeData.sendingAsssetId token
    /// @param payload The payload for the calls to be made at dest chain
    /// @param fee The fee to be payed in native token on src chain
    /// @param enableExpress enable Squid Router's instant execution service
    struct SquidData {
        RouteType routeType;
        string destinationChain;
        string destinationAddress; // required to allow future bridging to non-EVM networks
        string bridgedTokenSymbol;
        address depositAssetId;
        ISquidMulticall.Call[] sourceCalls;
        bytes payload;
        uint256 fee;
        bool enableExpress;
    }

    // introduced to tacke a stack-too-deep error
    struct BridgeContext {
        ILiFi.BridgeData bridgeData;
        SquidData squidData;
        uint256 msgValue;
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
        // if (
        //     !LibAsset.isNativeAsset(_bridgeData.sendingAssetId) &&
        //     keccak256(abi.encodePacked(_squidData.bridgedTokenSymbol)) !=
        //     keccak256(
        //         abi.encodePacked(ERC20(_bridgeData.sendingAssetId).symbol())
        //     )
        // ) {
        //     revert InformationMismatch();
        // }

        // validateDestinationCallFlag(_bridgeData, _squidData); //TODO: REMOVE OR REACTIVATE

        LibAsset.depositAsset(
            _squidData.depositAssetId,
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
        // if (
        //     !LibAsset.isNativeAsset(_bridgeData.sendingAssetId) &&
        //     keccak256(abi.encodePacked(_squidData.bridgedTokenSymbol)) !=
        //     keccak256(
        //         abi.encodePacked(ERC20(_bridgeData.sendingAssetId).symbol())
        //     )
        // ) {
        //     revert InformationMismatch();
        // }

        // validateDestinationCallFlag(_bridgeData, _squidData); //TODO: REMOVE OR REACTIVATE

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
        BridgeContext memory context = BridgeContext({
            bridgeData: _bridgeData,
            squidData: _squidData,
            msgValue: _calculateMsgValue(_bridgeData, _squidData)
        });

        if (!LibAsset.isNativeAsset(context.squidData.depositAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(context.squidData.depositAssetId),
                address(squidRouter),
                context.bridgeData.minAmount
            );
        }

        // call the correct execution function based on routeType
        if (_squidData.routeType == RouteType.BridgeCall) {
            _bridgeCall(context);
        } else if (_squidData.routeType == RouteType.CallBridge) {
            _callBridge(context);
        } else if (_squidData.routeType == RouteType.CallBridgeCall) {
            _callBridgeCall(context);
        } else {
            revert InvalidRouteType();
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    function _bridgeCall(BridgeContext memory _context) internal {
        squidRouter.bridgeCall{ value: _context.msgValue }(
            _context.squidData.bridgedTokenSymbol,
            _context.bridgeData.minAmount,
            _context.squidData.destinationChain,
            _context.squidData.destinationAddress,
            _context.squidData.payload,
            _context.bridgeData.receiver,
            _context.squidData.enableExpress
        );
    }

    function _callBridge(BridgeContext memory _context) private {
        squidRouter.callBridge{ value: _context.msgValue }(
            LibAsset.isNativeAsset(_context.squidData.depositAssetId)
                ? 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
                : _context.squidData.depositAssetId,
            _context.bridgeData.minAmount,
            _context.squidData.sourceCalls,
            _context.squidData.bridgedTokenSymbol,
            _context.squidData.destinationChain,
            LibBytes.toHexString(uint160(_context.bridgeData.receiver), 20)
        );
    }

    function _callBridgeCall(BridgeContext memory _context) private {
        squidRouter.callBridgeCall{ value: _context.msgValue }(
            LibAsset.isNativeAsset(_context.squidData.depositAssetId)
                ? 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
                : _context.squidData.depositAssetId,
            _context.bridgeData.minAmount,
            _context.squidData.sourceCalls,
            _context.squidData.bridgedTokenSymbol,
            _context.squidData.destinationChain,
            _context.squidData.destinationAddress,
            _context.squidData.payload,
            _context.bridgeData.receiver,
            _context.squidData.enableExpress
        );
    }

    function _calculateMsgValue(
        ILiFi.BridgeData memory _bridgeData,
        SquidData calldata _squidData
    ) private pure returns (uint256) {
        uint256 msgValue = _squidData.fee;
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            msgValue += _bridgeData.minAmount;
        }
        return msgValue;
    }

    //TODO: REMOVE???
    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        SquidData calldata _squidData
    ) private pure {
        if (
            (_squidData.payload.length > 0) != _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
