// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { MandateOutput, RegisterIntentLib } from "../Helpers/LIFIIntentLibraries.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

import { IBroadcastableSettler, MandateOutput, StandardOrder } from "../Interfaces/IOIF.sol";
import { ITheCompact } from "../Interfaces/ITheCompact.sol";

/// @title LIFIIntent Facet
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims representing LIFIIntent intents.
/// @custom:version 1.0.0
contract LIFIIntentFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Errors ///

    error IncorrectRegisteredClaimHash(
        bytes32 expectedClaimHash,
        bytes32 registeredClaimHash
    );
    error AssetIdsDoNotMatch();
    error ReceiverDoNotMatch();

    /// Storage ///

    /// @dev TheCompact, the escrow contract used for LIFIIntent.
    ITheCompact public immutable COMPACT;
    /// @dev LIFIIntent Compact Settler, containg logic for collecting assets from COMPACT.
    address public immutable LIFI_INTENT_COMPACT_SETTLER;

    /// Types ///

    /// @param receiverAddress The destination account for the delivered assets and calldata.
    /// @param inputAssetId Input token. The leftmost 12 bytes is the lockTag and the rightmost 20 is the address of the token which needs to be equal to the inputAssetId.
    /// @param expectedClaimHash Security check. If provided, it needs to match the returned claim hash from TheCompact.
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
    /// @param broadcast Whether to broadcast the intent on-chain. Note that this incurs additional gas costs.
    struct LIFIIntentData {
        bytes32 receiverAddress; // StandardOrder.outputs.recipient.
        /// BatchClaim
        uint256 inputAssetId; // StandardOrder.inputs[0]
        address user; // StandardOrder.user
        uint256 nonce; // StandardOrder.nonce
        uint32 expires; // StandardOrder.expiry
        // LIFIIntent Witness //
        uint32 fillDeadline; // StandardOrder.fillDeadline
        address inputOracle; // StandardOrder.localOracle
        // LIFIIntent Output //
        bytes32 outputOracle; // StandardOrder.outputs.oracle
        bytes32 outputSettler; // StandardOrder.outputs.settler
        bytes32 outputToken; // StandardOrder.outputs.token
        uint256 outputAmount; // StandardOrder.outputs.amount
        bytes outputCall; // StandardOrder.outputs.call
        bytes outputContext; // StandardOrder.outputs.context
        // Validation
        bytes32 expectedClaimHash;
        bool broadcast;
    }

    /// Constructor ///

    /// @param compact The Compact delopment, used as a deposit escrow.
    /// @param compactSettler LIFIIntent Compact arbiter / settlement implementation.
    constructor(address compact, address compactSettler) {
        if (compact == address(0) || compactSettler == address(0))
            revert InvalidConfig();
        COMPACT = ITheCompact(compact);
        LIFI_INTENT_COMPACT_SETTLER = compactSettler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LIFIIntent
    /// @param _bridgeData The core information needed for bridging
    /// @param _lifiIntentData Data specific to LIFIIntent
    function startBridgeTokensViaLIFIIntent(
        ILiFi.BridgeData memory _bridgeData,
        LIFIIntentData calldata _lifiIntentData
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
    function swapAndStartBridgeTokensViaLIFIIntent(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LIFIIntentData calldata _lifiIntentData
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
        LIFIIntentData calldata _lifiIntentData
    ) internal {
        // Check if theCompact and inputAssetId is the same token.
        // Both LI.Fi and theCompact uses address(0) for native token.
        if (
            asSanitizedAddress(_lifiIntentData.inputAssetId) !=
            _bridgeData.sendingAssetId
        ) revert AssetIdsDoNotMatch();

        // Check if the receiver is the same according to bridgeData and LIFIIntentData
        if (
            asSanitizedAddress(uint256(_lifiIntentData.receiverAddress)) !=
            _bridgeData.receiver
        ) {
            revert ReceiverDoNotMatch();
        }

        // Set approval.
        uint256 amount = _bridgeData.minAmount;
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(COMPACT),
            amount
        );

        // Convert given token and amount into a idsAndAmount array.
        // Notice that inputAssetId == NATIVE ASSET => inputAssetId = 0
        // Which is also the assetId that compact uses.
        uint256[2][] memory idsAndAmounts = new uint256[2][](1);
        idsAndAmounts[0] = [_lifiIntentData.inputAssetId, amount];

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

        RegisterIntentLib._validateExpiry(
            _lifiIntentData.fillDeadline,
            _lifiIntentData.expires
        );

        // Make the deposit on behalf of the user. We register the claim with the tokens the claim claims.
        (bytes32 registeredClaimHash, ) = COMPACT.batchDepositAndRegisterFor{
            value: LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
                ? amount
                : 0
        }(
            _lifiIntentData.user, // If the transaction fails, this will be who can claim the inputs.
            idsAndAmounts, // The amounts registered for theCompact.
            LIFI_INTENT_COMPACT_SETTLER, // Arbiter. Calling theCompact to send the asset to the solver.
            _lifiIntentData.nonce, // Unique allocator nonce to differentiate transactions.
            _lifiIntentData.expires, // Expiry of the intent.
            RegisterIntentLib.STANDARD_ORDER_BATCH_COMPACT_TYPE_HASH, // 712 typehash for the entire claim, including witness
            RegisterIntentLib.witnessHash(
                _lifiIntentData.fillDeadline,
                _lifiIntentData.inputOracle,
                outputs
            ) // LIFIIntent witness hash.
        );

        // Check if the returned claimHash matches the claim hash we expected.
        bytes32 expectedClaimHash = _lifiIntentData.expectedClaimHash;
        if (
            expectedClaimHash != 0 && registeredClaimHash != expectedClaimHash
        ) {
            revert IncorrectRegisteredClaimHash(
                registeredClaimHash,
                expectedClaimHash
            );
        }

        // Call broadcast on the settler.
        if (_lifiIntentData.broadcast)
            IBroadcastableSettler(LIFI_INTENT_COMPACT_SETTLER).broadcast(
                StandardOrder({
                    user: _lifiIntentData.user,
                    nonce: _lifiIntentData.nonce,
                    originChainId: block.chainid,
                    expires: _lifiIntentData.expires,
                    fillDeadline: _lifiIntentData.fillDeadline,
                    localOracle: _lifiIntentData.inputOracle,
                    inputs: idsAndAmounts,
                    outputs: outputs
                })
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
        uint256 accountValue
    ) internal pure returns (address account) {
        assembly ("memory-safe") {
            account := shr(96, shl(96, accountValue))
        }
    }
}
