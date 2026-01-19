// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InvalidReceiver, InvalidAmount, InformationMismatch } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

import { MandateOutput, StandardOrder } from "../Interfaces/IOpenIntentFramework.sol";
import { IOriginSettler } from "../Interfaces/IOriginSettler.sol";

/// @title LiFiIntentEscrowFacet
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims directly on a OIF Input Settler
/// @custom:version 1.1.0
contract LiFiIntentEscrowFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @dev LIFI Intent Escrow Input Settler
    address public immutable LIFI_INTENT_ESCROW_SETTLER;

    /// Types ///

    /// @param dstCallReceiver If dstCallSwapData.length > 0, has to be provided as a deployment of `ReceiverOIF`. Otherwise ignored.
    /// @param recipient The end recipient of the swap. If no calldata is included, will be a simple recipient, otherwise it will be encoded as the end destination for the swaps.
    /// @param depositAndRefundAddress The deposit and claim registration will be made for. If any refund is made, it will be sent to this address
    /// @param nonce OrderId mixer. Used within the intent system to generate unique orderIds for each user. Should not be reused for `depositAndRefundAddress`
    /// @param expires If the proof for the fill does not arrive before this time, the claim expires
    /// @param fillDeadline The fill has to happen before this time
    /// @param inputOracle Address of the validation layer used on the input chain
    /// @param outputOracle Address of the validation layer used on the output chain
    /// @param outputSettler Address of the output settlement contract containing the fill logic
    /// @param outputToken The desired destination token
    /// @param outputAmount The amount of the desired token
    /// @param dstCallSwapData List of swaps to be executed on the destination chain. Is called on dstCallReceiver. If empty no call is made.
    /// @param outputContext Context for the outputSettler to identify the order type
    struct LiFiIntentEscrowData {
        // Goes into StandardOrder.outputs.recipient if .dstCallSwapData.length > 0
        bytes32 dstCallReceiver;
        // Goes into StandardOrder.outputs.recipient if .dstCallSwapData.length == 0
        bytes32 recipient;
        /// BatchClaim
        address depositAndRefundAddress; // StandardOrder.user
        uint256 nonce; // StandardOrder.nonce
        uint32 expires; // StandardOrder.expiry
        uint32 fillDeadline; // StandardOrder.fillDeadline
        address inputOracle; // StandardOrder.inputOracle
        bytes32 outputOracle; // StandardOrder.outputs.oracle
        bytes32 outputSettler; // StandardOrder.outputs.settler
        bytes32 outputToken; // StandardOrder.outputs.token
        uint256 outputAmount; // StandardOrder.outputs.amount
        LibSwap.SwapData[] dstCallSwapData; // Goes into StandardOrder.outputs.callbackData
        bytes outputContext; // StandardOrder.outputs.context
    }

    /// Constructor ///

    /// @param _inputSettler LIFIIntent Escrow / settlement implementation
    constructor(address _inputSettler) {
        if (_inputSettler == address(0)) revert InvalidConfig();
        LIFI_INTENT_ESCROW_SETTLER = _inputSettler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function startBridgeTokensViaLiFiIntentEscrow(
        ILiFi.BridgeData memory _bridgeData,
        LiFiIntentEscrowData calldata _lifiIntentData
    )
        external
        nonReentrant
        noNativeAsset(_bridgeData)
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _lifiIntentData);
    }

    /// @notice Performs a swap before bridging via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function swapAndStartBridgeTokensViaLiFiIntentEscrow(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LiFiIntentEscrowData calldata _lifiIntentData
    )
        external
        payable
        nonReentrant
        noNativeAsset(_bridgeData)
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        uint256 swapOutcome = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        // Return positive slippage to user if any
        if (swapOutcome > _bridgeData.minAmount) {
            LibAsset.transferAsset(
                _bridgeData.sendingAssetId,
                payable(msg.sender),
                swapOutcome - _bridgeData.minAmount
            );
        }

        _startBridge(_bridgeData, _lifiIntentData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        LiFiIntentEscrowData calldata _lifiIntentData
    ) internal {
        uint256 dstCallSwapDataLength = _lifiIntentData.dstCallSwapData.length;
        // Validate destination call flag matches actual behavior
        if ((dstCallSwapDataLength > 0) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }
        if (_lifiIntentData.depositAndRefundAddress == address(0))
            revert InvalidReceiver();
        if (_lifiIntentData.outputAmount == 0) revert InvalidAmount();

        // We wanna create a "canonical" recipient so we don't have to argue for which one (bridgeData/LIFIIntentData) to use.
        bytes32 recipient = _lifiIntentData.recipient;
        if (recipient == bytes32(0)) revert InvalidReceiver();
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // In this case, _bridgeData.receiver is not useful.
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                recipient
            );
        } else {
            // Check if the receiver is the same according to bridgeData and LIFIIntentData
            // Note: We already know 0 <= _bridgeData.receiver < recipient != 0 thus _bridgeData.receiver != 0.
            if (recipient != bytes32(uint256(uint160(_bridgeData.receiver)))) {
                revert InvalidReceiver();
            }
        }

        address sendingAsset = _bridgeData.sendingAssetId;
        // Set approval
        uint256 amount = _bridgeData.minAmount;
        LibAsset.maxApproveERC20(
            IERC20(sendingAsset),
            address(LIFI_INTENT_ESCROW_SETTLER),
            amount
        );

        bytes memory outputCall = hex"";
        if (dstCallSwapDataLength != 0) {
            // If we have external calldata, we need to swap out our recipient to the remote caller. We won't be using the recipient anymore so this is without side effects.
            recipient = _lifiIntentData.dstCallReceiver;
            // Check that _lifiIntentData.dstCallReceiver != 0.
            if (recipient == bytes32(0)) revert InvalidReceiver();

            // Add swap data to the output call.
            outputCall = abi.encode(
                _bridgeData.transactionId,
                _lifiIntentData.dstCallSwapData,
                _lifiIntentData.recipient
            );
        }

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: _lifiIntentData.outputOracle,
            settler: _lifiIntentData.outputSettler,
            chainId: _bridgeData.destinationChainId,
            token: _lifiIntentData.outputToken,
            amount: _lifiIntentData.outputAmount,
            recipient: recipient,
            callbackData: outputCall,
            context: _lifiIntentData.outputContext
        });

        // Convert given token and amount into a idsAndAmount array
        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(sendingAsset)), amount];

        // Make the deposit on behalf of the user
        IOriginSettler(LIFI_INTENT_ESCROW_SETTLER).open(
            StandardOrder({
                user: _lifiIntentData.depositAndRefundAddress,
                nonce: _lifiIntentData.nonce,
                originChainId: block.chainid,
                expires: _lifiIntentData.expires,
                fillDeadline: _lifiIntentData.fillDeadline,
                inputOracle: _lifiIntentData.inputOracle,
                inputs: inputs,
                outputs: outputs
            })
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
