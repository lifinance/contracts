// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InvalidReceiver, InvalidAmount, InformationMismatch } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

import { MandateOutput, StandardOrder } from "../Interfaces/IOpenIntentFramework.sol";
import { IOriginSettler } from "../Interfaces/IOriginSettler.sol";

/// @title LiFiIntentEscrowFacetV2
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims directly on a OIF Input Settler.
/// @notice This contract is not intended to custody user funds; any balance held is incidental (transient during execution) and should not persist.
/// @custom:version 1.0.0
contract LiFiIntentEscrowFacetV2 is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// @notice Validates bridge data for LIFIIntent escrow deposits.
    /// @dev Does not enforce a same-network guard because same-chain
    ///      intents are supported.
    /// @param _bridgeData The core information needed for bridging
    modifier validateBridgeDataLiFiIntentEscrowV2(
        ILiFi.BridgeData memory _bridgeData
    ) {
        if (LibUtil.isZeroAddress(_bridgeData.receiver))
            revert InvalidReceiver();
        if (_bridgeData.minAmount == 0) revert InvalidAmount();
        _;
    }

    /// Errors ///

    error InvalidDepositAndRefundAddress();

    /// Storage ///

    /// @dev LIFI Intent Escrow Input Settler
    address public immutable LIFI_INTENT_ESCROW_SETTLER_V2;

    /// @notice The base for `outputAmountMultiplier` (1e18 = 100%), leaving room to
    ///         scale in both directions including input/output decimal differences.
    uint256 internal constant MULTIPLIER_BASE = 1e18;

    /// Types ///

    /// @param dstCallReceiver If dstCallSwapData.length > 0, becomes the on-chain output recipient and must be a `ReceiverOIF` deployment. On-chain it is only checked to be non-zero, not verified to be an instance of `ReceiverOIF`. If it is any other address that accepts an OIF callback, funds may be lost. Ignored when dstCallSwapData.length == 0.
    /// @param recipient The end recipient of the swap. If no calldata is included, will be a simple recipient, otherwise it will be encoded as the end destination for the swaps.
    /// @param depositAndRefundAddress The deposit and claim registration will be made for. If any refund is made, it will be sent to this address
    /// @param nonce OrderId mixer. Used within the intent system to generate unique orderIds for each user. Should not be reused for `depositAndRefundAddress`
    /// @param expires If the proof for the fill does not arrive before this time, the claim expires
    /// @param fillDeadline The fill has to happen before this time
    /// @param inputOracle Address of the validation layer used on the input chain
    /// @param outputOracle Address of the validation layer used on the output chain
    /// @param outputSettler Address of the output settlement contract containing the fill logic
    /// @param outputToken The desired destination token
    /// @param outputAmountMultiplier Scaling factor against `MULTIPLIER_BASE` (1e18 = 100%). On both entrypoints the committed output is `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`, folding the backend-quoted price ratio and any input/output decimal difference into one factor (`multiplierPercentage * 1e18 * 10^(outputDecimals - inputDecimals)`). Use only LI.FI backend-generated calldata.
    /// @param dstCallSwapData List of swaps to be executed on the destination chain. Is called on dstCallReceiver. If empty no call is made.
    /// @param outputContext Context for the outputSettler to identify the order type
    struct LiFiIntentEscrowDataV2 {
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
        uint128 outputAmountMultiplier; // output scaling factor (both entrypoints)
        LibSwap.SwapData[] dstCallSwapData; // Goes into StandardOrder.outputs.callbackData
        bytes outputContext; // StandardOrder.outputs.context
    }

    /// Constructor ///

    /// @param _inputSettler LIFIIntent Escrow / settlement implementation
    constructor(address _inputSettler) {
        if (LibUtil.isZeroAddress(_inputSettler)) revert InvalidConfig();
        LIFI_INTENT_ESCROW_SETTLER_V2 = _inputSettler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function startBridgeTokensViaLiFiIntentEscrowV2(
        ILiFi.BridgeData memory _bridgeData,
        LiFiIntentEscrowDataV2 calldata _lifiIntentData
    )
        external
        nonReentrant
        noNativeAsset(_bridgeData)
        validateBridgeDataLiFiIntentEscrowV2(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        if (_lifiIntentData.depositAndRefundAddress == address(0))
            revert InvalidDepositAndRefundAddress();
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        uint256 effectiveOutputAmount = (_bridgeData.minAmount *
            _lifiIntentData.outputAmountMultiplier) / MULTIPLIER_BASE;
        _startBridge(_bridgeData, _lifiIntentData, effectiveOutputAmount);
    }

    /// @notice Performs a swap before bridging via LIFIIntent
    /// @dev The committed destination output is
    ///      `realizedSwapOutput * outputAmountMultiplier / MULTIPLIER_BASE`.
    ///      `_bridgeData.minAmount` is the worst-case swap output enforced as the
    ///      `_depositAndSwap` slippage floor. The multiplier folds the
    ///      backend-quoted price ratio and any input/output decimal difference
    ///      into one 1e18-based factor. Use only LI.FI backend-generated calldata;
    ///      see "Output Amount Scaling" in `docs/LiFiIntentEscrowFacetV2.md`.
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function swapAndStartBridgeTokensViaLiFiIntentEscrowV2(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LiFiIntentEscrowDataV2 calldata _lifiIntentData
    )
        external
        payable
        nonReentrant
        noNativeAsset(_bridgeData)
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeDataLiFiIntentEscrowV2(_bridgeData)
    {
        address depositAndRefundAddress = _lifiIntentData
            .depositAndRefundAddress;
        if (depositAndRefundAddress == address(0))
            revert InvalidDepositAndRefundAddress();

        // `_bridgeData.minAmount` is the worst-case swap output; `_depositAndSwap`
        // reverts unless the realized output meets it.
        uint256 swapOutcome = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(depositAndRefundAddress)
        );

        // Positive slippage funds the intent rather than being refunded; the
        // multiplier holds the committed output at the backend's quoted ratio and
        // absorbs any input/output decimal difference.
        uint256 effectiveOutputAmount = (swapOutcome *
            _lifiIntentData.outputAmountMultiplier) / MULTIPLIER_BASE;
        _bridgeData.minAmount = swapOutcome;

        _startBridge(_bridgeData, _lifiIntentData, effectiveOutputAmount);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    /// @param _effectiveOutputAmount The outputAmount to commit to the intent;
    ///        always `inputAmount * outputAmountMultiplier / MULTIPLIER_BASE`.
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        LiFiIntentEscrowDataV2 calldata _lifiIntentData,
        uint256 _effectiveOutputAmount
    ) internal {
        uint256 dstCallSwapDataLength = _lifiIntentData.dstCallSwapData.length;
        // Validate destination call flag matches actual behavior
        if ((dstCallSwapDataLength > 0) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }
        if (_effectiveOutputAmount == 0) revert InvalidAmount();

        // We wanna create a "canonical" recipient so we don't have to argue for which one (bridgeData/LIFIIntentData) to use.
        bytes32 recipient = _lifiIntentData.recipient;
        if (recipient == bytes32(0)) revert InvalidReceiver();
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // Destination calls require an EVM `ReceiverOIF`. This is an EVM contract.
            if (dstCallSwapDataLength != 0) revert InformationMismatch();
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
            address(LIFI_INTENT_ESCROW_SETTLER_V2),
            amount
        );

        bytes memory outputCall = hex"";
        if (dstCallSwapDataLength != 0) {
            // If we have external calldata, we need to swap out our recipient to the remote caller. We won't be using the recipient anymore so this is without side effects.
            // Trust assumption: `dstCallReceiver` is the on-chain fund recipient here and
            // is only checked to be non-zero — NOT verified to be a genuine `ReceiverOIF`.
            // The `bridgeData.receiver` guard above does not protect funds on this path.
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
            amount: _effectiveOutputAmount,
            recipient: recipient,
            callbackData: outputCall,
            context: _lifiIntentData.outputContext
        });

        // Convert given token and amount into a idsAndAmount array
        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(sendingAsset)), amount];

        // Make the deposit on behalf of the user
        IOriginSettler(LIFI_INTENT_ESCROW_SETTLER_V2).open(
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
