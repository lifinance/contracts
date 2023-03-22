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

/// @title CelerIM Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging tokens and data through CBridge
contract CelerIMFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @dev The contract address of the cBridge Message Bus
    IMessageBus private immutable cBridgeMessageBus;

    /// @dev The contract address of the RelayerCelerIM
    RelayerCelerIM private immutable relayer;

    /// @dev The contract address of the Celer Flow USDC
    address private immutable cfUSDC;

    /// Types ///

    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    /// @param nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
    /// @param callTo the address of the contract to be called at destination
    /// @param callData the encoded calldata (bytes32 transactionId, LibSwap.SwapData[] memory swapData, address receiver, address refundAddress)
    /// @param messageBusFee the fee to be paid to CBridge message bus for relaying the message
    /// @param bridgeType defines the bridge operation type (must be one of the values of CBridge library MsgDataTypes.BridgeSendType)
    struct CelerIMData {
        uint32 maxSlippage;
        uint64 nonce;
        bytes callTo;
        bytes callData;
        uint256 messageBusFee;
        MsgDataTypes.BridgeSendType bridgeType;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _messageBus The contract address of the cBridge Message Bus
    /// @param _relayer The contract address of the RelayerCelerIM
    /// @param _cfUSDC The contract address of the Celer Flow USDC
    constructor(IMessageBus _messageBus, RelayerCelerIM _relayer, address _cfUSDC) {
        cBridgeMessageBus = _messageBus;
        relayer = _relayer;
        cfUSDC = _cfUSDC;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _celerIMData data specific to CelerIM
    function startBridgeTokensViaCelerIM(
        ILiFi.BridgeData memory _bridgeData,
        CelerIMData calldata _celerIMData
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
            // transfer ERC20 tokens directly to relayer
            IERC20 asset;
            if (_bridgeData.sendingAssetId == cfUSDC) {
                // special case for cfUSDC token
                asset = IERC20(
                    CelerToken(_bridgeData.sendingAssetId).canonical()
                );
            } else {
                // any other ERC20 token
                asset = IERC20(_bridgeData.sendingAssetId);
            }
            // deposit ERC20 token
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
            ) revert InvalidAmount();
        }
        _startBridge(_bridgeData, _celerIMData);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _celerIMData data specific to CelerIM
    function swapAndStartBridgeTokensViaCelerIM(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CelerIMData memory _celerIMData
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
            payable(msg.sender)
        );
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // transfer ERC20 tokens directly to relayer
            IERC20 asset = IERC20(_bridgeData.sendingAssetId);
            uint256 prevBalance = asset.balanceOf(address(relayer));
            SafeERC20.safeTransfer(
                asset,
                address(relayer),
                _bridgeData.minAmount
            );
            if (
                asset.balanceOf(address(relayer)) - prevBalance !=
                _bridgeData.minAmount
            ) revert InvalidAmount();
        }

        _startBridge(_bridgeData, _celerIMData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _celerIMData data specific to CBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CelerIMData memory _celerIMData
    ) private {
        // assuming messageBusFee is pre-calculated off-chain and available in _celerIMData
        // determine correct native asset amount to be forwarded (if so) and send funds to relayer
        uint256 msgValue = LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
            ? _bridgeData.minAmount
            : 0;
        // check if transaction contains a destination call
        if (!_bridgeData.hasDestinationCall) {
            // case 'no': simple bridge transfer - send to receiver
            relayer.sendTokenTransfer{ value: msgValue }(_bridgeData, _celerIMData);
        } else {
            // case 'yes': bridge + dest call - send to relayer
            ILiFi.BridgeData memory bridgeDataAdjusted = _bridgeData;
            bridgeDataAdjusted.receiver = address(relayer);
            (bytes32 transferId, address bridgeAddress) = relayer
            .sendTokenTransfer{ value: msgValue }(bridgeDataAdjusted, _celerIMData);
            // call message bus via relayer incl messageBusFee
            relayer.forwardSendMessageWithTransfer{value: _celerIMData.messageBusFee}(
                _bridgeData.receiver,
                uint64(_bridgeData.destinationChainId),
                bridgeAddress,
                transferId,
                _celerIMData.callData
            );
        }

        // emit LiFi event
        emit LiFiTransferStarted(_bridgeData);
    }

    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        CelerIMData memory _celerIMData
    ) private pure {
        if (
            (_celerIMData.callData.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
    }
}
