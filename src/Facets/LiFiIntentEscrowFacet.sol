// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InvalidReceiver, NativeAssetNotSupported } from "../Errors/GenericErrors.sol";

import { MandateOutput, StandardOrder } from "../Interfaces/IOpenIntentFramework.sol";
import { IOriginSettler } from "../Interfaces/IOriginSettler.sol";

/// @title LIFIIntent Facet
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims directly on a OIF Input Settler
/// @custom:version 1.0.0
contract LiFiIntentEscrowFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Storage ///

    /// @dev LIFI Intent Escrow Input Settler.
    address public immutable LIFI_INTENT_ESCROW_SETTLER;

    /// Types ///

    /// @param receiverAddress The destination account for the delivered assets and calldata.
    /// @param depositAndRefundAddress The deposit and claim registration will be made for. If any refund is made, it will be sent to this address.
    /// @param expires If the proof for the fill does not arrive before this time, the claim expires.
    /// @param fillDeadline The fill has to happen before this time.
    /// @param inputOracle Address of the validation layer used on the input chain.
    /// @param outputOracle Address of the validation layer used on the output chain.
    /// @param outputSettler Address of the output settlement contract containing the fill logic.
    /// @param outputToken The desired destination token.
    /// @param outputAmount The amount of the desired token.
    /// @param outputCall Calldata to be executed after the token has been delivered. Is called on receiverAddress. if set to 0x / hex"" no call is made.
    /// @param outputContext Context for the outputSettler to identify the order type.
    struct LiFiIntentEscrowData {
        bytes32 receiverAddress; // StandardOrder.outputs.recipient
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
        bytes outputCall; // StandardOrder.outputs.callbackData
        bytes outputContext; // StandardOrder.outputs.context
    }

    /// Constructor ///

    /// @param _inputSettler LIFIIntent Escrow / settlement implementation.
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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
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
        address sendingAsset = _bridgeData.sendingAssetId;
        if (sendingAsset == address(0)) revert NativeAssetNotSupported();

        // Check if the receiver is the same according to bridgeData and LIFIIntentData
        if (
            address(uint160(uint256(_lifiIntentData.receiverAddress))) !=
            _bridgeData.receiver
        ) {
            revert InvalidReceiver();
        }

        // Set approval.
        uint256 amount = _bridgeData.minAmount;
        LibAsset.maxApproveERC20(
            IERC20(sendingAsset),
            address(LIFI_INTENT_ESCROW_SETTLER),
            amount
        );

        // Convert given token and amount into a idsAndAmount array.
        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(sendingAsset)), amount];

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: _lifiIntentData.outputOracle,
            settler: _lifiIntentData.outputSettler,
            chainId: _bridgeData.destinationChainId,
            token: _lifiIntentData.outputToken,
            amount: _lifiIntentData.outputAmount,
            recipient: _lifiIntentData.receiverAddress,
            callbackData: _lifiIntentData.outputCall,
            context: _lifiIntentData.outputContext
        });

        // Make the deposit on behalf of the user..
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
