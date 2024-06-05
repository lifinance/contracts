// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IStargate, ITokenMessaging } from "../Interfaces/IStargate.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InformationMismatch, AlreadyInitialized, NotInitialized, ContractCallNotAllowed, InvalidCallData } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

/// @title StargateFacetV2
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Stargate (V2)
/// @custom:version 1.0.0
contract StargateFacetV2 is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for ERC20;

    /// STORAGE ///
    ITokenMessaging public immutable tokenMessaging;

    /// @param assetId The Stargate-specific assetId for the token that should be bridged
    /// @param sendParams Various parameters that describe what needs to be bridged, how to bridge it and what to do with it on dst
    /// @param fee Information about the (native) LayerZero fee that needs to be sent with the tx
    /// @param refundAddress the address that is used for potential refunds
    struct StargateData {
        uint16 assetId;
        IStargate.SendParam sendParams;
        IStargate.MessagingFee fee;
        address payable refundAddress;
    }

    /// ERRORS ///
    error InvalidAssetId(uint16 invalidAssetId);

    /// CONSTRUCTOR ///
    /// @param _tokenMessaging The address of the tokenMessaging contract (used to obtain pool addresses)
    constructor(address _tokenMessaging) {
        tokenMessaging = ITokenMessaging(_tokenMessaging);
    }

    /// EXTERNAL METHODS ///

    /// @notice Bridges tokens via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    function startBridgeTokensViaStargate(
        ILiFi.BridgeData calldata _bridgeData,
        StargateData calldata _stargateData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _stargateData);
    }

    /// @notice Performs a swap before bridging via Stargate Bridge
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _stargateData Data specific to Stargate Bridge
    function swapAndStartBridgeTokensViaStargate(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        StargateData calldata _stargateData
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
            payable(msg.sender),
            _stargateData.fee.nativeFee
        );

        _startBridge(_bridgeData, _stargateData);
    }

    /// PRIVATE METHODS ///

    /// @dev Contains the business logic for the bridging via StargateV2
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _stargateData Data specific to Stargate Bridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        StargateData calldata _stargateData
    ) private {
        _validateDestinationCallFlag(_bridgeData, _stargateData);

        // get the address of the Stargate pool/router contract
        address routerAddress = _getRouterAddress(_stargateData.assetId);

        // check if NATIVE or ERC20
        uint256 msgValue = _stargateData.fee.nativeFee;
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // NATIVE
            // add minAmount to msgValue
            msgValue += _bridgeData.minAmount;
        } else {
            // ERC20
            // check current allowance to router
            ERC20 sendingAsset = ERC20(_bridgeData.sendingAssetId);
            uint256 currentAllowance = sendingAsset.allowance(
                address(this),
                routerAddress
            );
            // check if allowance is sufficient
            if (currentAllowance < _bridgeData.minAmount) {
                // check if allowance is 0
                if (currentAllowance != 0) {
                    sendingAsset.approve(routerAddress, 0);
                }
                // set allowance to uintMax
                sendingAsset.approve(routerAddress, type(uint256).max);
            }
        }

        // execute call to Stargate router
        IStargate(routerAddress).sendToken{ value: msgValue }(
            _stargateData.sendParams,
            _stargateData.fee,
            _stargateData.refundAddress
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// PRIVATE HELPER METHODS ///
    /// @dev makes sure that calldata contains payload for destination when bridging tokens+destCall
    function _validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        StargateData calldata _stargateData
    ) private pure {
        if (
            (_stargateData.sendParams.composeMsg.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }

    /// @dev returns the pool-/routerAddress for a given asset(Id), reverts if no address can be found
    function _getRouterAddress(
        uint16 assetId
    ) private returns (address routerAddress) {
        // get the router-/pool address through the TokenMessaging contract
        routerAddress = tokenMessaging.stargateImpls(assetId);
        if (routerAddress == address(0)) revert InvalidAssetId(assetId);
    }

    receive() external payable {}
}
