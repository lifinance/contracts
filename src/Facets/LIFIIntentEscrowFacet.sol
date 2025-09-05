// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

import { MandateOutput, StandardOrder } from "../Interfaces/IOIF.sol";
import { IOriginSettler } from "../Interfaces/IOriginSettler.sol";

/// @title LIFIIntent Facet
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims directly on a 7683 compatible OIF Input Settler
/// @custom:version 1.0.0
contract LIFIIntentEscrowFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable
{
    /// Errors ///

    error ReceiverDoNotMatch();
    error NativeNotSupported();

    /// Storage ///

    /// @dev LIFIIntent Compact Settler, containg logic for collecting assets from COMPACT.
    address public immutable LIFI_INTENT_ESCROW_SETTLER;

    /// Types ///

    /// @param receiverAddress The destination account for the delivered assets and calldata.
    /// @param user The deposit and claim registration will be made in this user's name. Compact 6909 tokens will be minted for this user and if the intent fails to be filled the tokens will remain in this user's name.
    /// @param expiry If the proof for the fill does not arrive before this time, the claim expires.
    /// @param fillDeadline The fill has to happen before this time.
    /// @param inputOracle Address of the validation layer used on the input chain.
    /// @param outputOracle Address of the validation layer used on the output chain.
    /// @param outputSettler Address of the output settlement contract containing the fill logic.
    /// @param outputToken The desires destination token.
    /// @param outputAmount The amount of the destired token.
    /// @param outputCall Calldata to be executed after the token has been delivered. Is called on receiverAddress. if set to 0x / hex"" no call is made.
    /// @param outputContext Context for the outputSettler to identify the order type.
    struct LIFIIntentEscrowData {
        bytes32 receiverAddress; // StandardOrder.outputs.recipient
        /// BatchClaim
        address user; // StandardOrder.user
        uint256 nonce; // StandardOrder.nonce
        uint32 expires; // StandardOrder.expiry
        uint32 fillDeadline; // StandardOrder.fillDeadline
        address inputOracle; // StandardOrder.inputOracle
        bytes32 outputOracle; // StandardOrder.outputs.oracle
        bytes32 outputSettler; // StandardOrder.outputs.settler
        bytes32 outputToken; // StandardOrder.outputs.token
        uint256 outputAmount; // StandardOrder.outputs.amount
        bytes outputCall; // StandardOrder.outputs.call
        bytes outputContext; // StandardOrder.outputs.context
    }

    /// Constructor ///

    /// @param inputSettler LIFIIntent Escrow / settlement implementation.
    constructor(address inputSettler) {
        if (inputSettler == address(0)) revert InvalidConfig();
        LIFI_INTENT_ESCROW_SETTLER = inputSettler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function startBridgeTokensViaLIFIIntentEscrow(
        ILiFi.BridgeData memory _bridgeData,
        LIFIIntentEscrowData calldata _lifiIntentData
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
    function swapAndStartBridgeTokensViaLIFIIntentEscrow(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LIFIIntentEscrowData calldata _lifiIntentData
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
        LIFIIntentEscrowData calldata _lifiIntentData
    ) internal {
        if (_bridgeData.sendingAssetId == address(0))
            revert NativeNotSupported();

        // Check if the receiver is the same according to bridgeData and LIFIIntentData
        if (
            asSanitizedAddress(_lifiIntentData.receiverAddress) !=
            _bridgeData.receiver
        ) {
            revert ReceiverDoNotMatch();
        }

        // Set approval.
        uint256 amount = _bridgeData.minAmount;
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(LIFI_INTENT_ESCROW_SETTLER),
            amount
        );

        // Convert given token and amount into a idsAndAmount array.
        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(_bridgeData.sendingAssetId)), amount];

        MandateOutput[] memory outputs = new MandateOutput[](1);
        outputs[0] = MandateOutput({
            oracle: _lifiIntentData.outputOracle,
            settler: _lifiIntentData.outputSettler,
            chainId: _bridgeData.destinationChainId,
            token: _lifiIntentData.outputToken,
            amount: _lifiIntentData.outputAmount,
            recipient: _lifiIntentData.receiverAddress,
            call: _lifiIntentData.outputCall,
            context: _lifiIntentData.outputContext
        });

        // Make the deposit on behalf of the user. We register the claim with the tokens the claim claims.
        IOriginSettler(LIFI_INTENT_ESCROW_SETTLER).open(
            abi.encode(
                StandardOrder({
                    user: _lifiIntentData.user,
                    nonce: _lifiIntentData.nonce,
                    originChainId: block.chainid,
                    expires: _lifiIntentData.expires,
                    fillDeadline: _lifiIntentData.fillDeadline,
                    inputOracle: _lifiIntentData.inputOracle,
                    inputs: inputs,
                    outputs: outputs
                })
            )
        );

        emit LiFiTransferStarted(_bridgeData);
    }
    /// Helpers ///

    /**
     * @notice Internal pure function that sanitizes an address by clearing the
     * upper 96 bits. Used for ensuring consistent address handling.
     * @param accountValue The value to sanitize.
     * @return account     The sanitized address.
     */
    function asSanitizedAddress(
        bytes32 accountValue
    ) internal pure returns (address account) {
        assembly ("memory-safe") {
            account := shr(96, shl(96, accountValue))
        }
    }
}
