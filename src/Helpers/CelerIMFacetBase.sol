// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidAmount, InformationMismatch } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { MessageSenderLib, MsgDataTypes, IMessageBus } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";

interface CelerToken {
    function canonical() external returns (address);
}

interface CelerIM {
    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    /// @param nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
    /// @param callTo The address of the contract to be called at destination.
    /// @param callData The encoded calldata with below data
    ///                 bytes32 transactionId,
    ///                 LibSwap.SwapData[] memory swapData,
    ///                 address receiver,
    ///                 address refundAddress
    /// @param messageBusFee The fee to be paid to CBridge message bus for relaying the message
    /// @param bridgeType Defines the bridge operation type (must be one of the values of CBridge library MsgDataTypes.BridgeSendType)
    struct CelerIMData {
        uint32 maxSlippage;
        uint64 nonce;
        bytes callTo;
        bytes callData;
        uint256 messageBusFee;
        MsgDataTypes.BridgeSendType bridgeType;
    }
}

/// @title CelerIM Facet Base
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging tokens and data through CBridge
/// @notice Used to differentiate between contract instances for mutable and immutable diamond as these cannot be shared
/// @custom:version 2.0.0
abstract contract CelerIMFacetBase is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @dev The contract address of the cBridge Message Bus
    IMessageBus private immutable cBridgeMessageBus;

    /// @dev The contract address of the RelayerCelerIM
    RelayerCelerIM public immutable relayer;

    /// @dev The contract address of the Celer Flow USDC
    address private immutable cfUSDC;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _messageBus The contract address of the cBridge Message Bus
    /// @param _relayerOwner The address that will become the owner of the RelayerCelerIM contract
    /// @param _diamondAddress The address of the diamond contract that will be connected with the RelayerCelerIM
    /// @param _cfUSDC The contract address of the Celer Flow USDC
    constructor(
        IMessageBus _messageBus,
        address _relayerOwner,
        address _diamondAddress,
        address _cfUSDC
    ) {
        // deploy RelayerCelerIM
        relayer = new RelayerCelerIM(
            address(_messageBus),
            _relayerOwner,
            _diamondAddress
        );

        // store arguments in variables
        cBridgeMessageBus = _messageBus;
        cfUSDC = _cfUSDC;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _celerIMData Data specific to CelerIM
    function startBridgeTokensViaCelerIM(
        ILiFi.BridgeData memory _bridgeData,
        CelerIM.CelerIMData calldata _celerIMData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _celerIMData);
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Transfer ERC20 tokens directly to relayer
            IERC20 asset = _getRightAsset(_bridgeData.sendingAssetId);

            // Deposit ERC20 token
            uint256 prevBalance = asset.balanceOf(address(relayer));
            SafeERC20.safeTransferFrom(
                asset,
                msg.sender,
                address(relayer),
                _bridgeData.minAmount
            );

            if (
                asset.balanceOf(address(relayer)) - prevBalance !=
                _bridgeData.minAmount
            ) {
                revert InvalidAmount();
            }
        }

        _startBridge(_bridgeData, _celerIMData);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _celerIMData Data specific to CelerIM
    function swapAndStartBridgeTokensViaCelerIM(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CelerIM.CelerIMData calldata _celerIMData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _celerIMData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _celerIMData.messageBusFee
        );

        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Transfer ERC20 tokens directly to relayer
            IERC20 asset = _getRightAsset(_bridgeData.sendingAssetId);

            // Deposit ERC20 token
            uint256 prevBalance = asset.balanceOf(address(relayer));
            SafeERC20.safeTransfer(
                asset,
                address(relayer),
                _bridgeData.minAmount
            );

            if (
                asset.balanceOf(address(relayer)) - prevBalance !=
                _bridgeData.minAmount
            ) {
                revert InvalidAmount();
            }
        }

        _startBridge(_bridgeData, _celerIMData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _celerIMData Data specific to CBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CelerIM.CelerIMData calldata _celerIMData
    ) private {
        // Assuming messageBusFee is pre-calculated off-chain and available in _celerIMData
        // Determine correct native asset amount to be forwarded (if so) and send funds to relayer
        uint256 msgValue = LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
            ? _bridgeData.minAmount
            : 0;

        // Check if transaction contains a destination call
        if (!_bridgeData.hasDestinationCall) {
            // Case 'no': Simple bridge transfer - Send to receiver
            relayer.sendTokenTransfer{ value: msgValue }(
                _bridgeData,
                _celerIMData
            );
        } else {
            // Case 'yes': Bridge + Destination call - Send to relayer

            // save address of original recipient
            address receiver = _bridgeData.receiver;

            // Set relayer as a receiver
            _bridgeData.receiver = address(relayer);

            // send token transfer
            (bytes32 transferId, address bridgeAddress) = relayer
                .sendTokenTransfer{ value: msgValue }(
                _bridgeData,
                _celerIMData
            );

            // Call message bus via relayer incl messageBusFee
            relayer.forwardSendMessageWithTransfer{
                value: _celerIMData.messageBusFee
            }(
                _bridgeData.receiver,
                uint64(_bridgeData.destinationChainId),
                bridgeAddress,
                transferId,
                _celerIMData.callData
            );

            // Reset receiver of bridge data for event emission
            _bridgeData.receiver = receiver;
        }

        // emit LiFi event
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Get right asset to transfer to relayer.
    /// @param _sendingAssetId The address of asset to bridge.
    /// @return _asset The address of asset to transfer to relayer.
    function _getRightAsset(
        address _sendingAssetId
    ) private returns (IERC20 _asset) {
        if (_sendingAssetId == cfUSDC) {
            // special case for cfUSDC token
            _asset = IERC20(CelerToken(_sendingAssetId).canonical());
        } else {
            // any other ERC20 token
            _asset = IERC20(_sendingAssetId);
        }
    }

    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        CelerIM.CelerIMData calldata _celerIMData
    ) private pure {
        if (
            (_celerIMData.callData.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
