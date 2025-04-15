// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { OutputDescription, CatalystCompactOrder, TheCompactOrderType } from "../Helpers/CatalystLibraries.sol";

import { ITheCompact } from "../interfaces/ITheCompact.sol";

/// @title Catalyst Facet
/// @author LI.FI (https://li.fi)
/// @notice Deposits and registers claims representing Catalyst intents.
/// @custom:version 1.0.0
contract CatalystFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Errors ///

    error IncorrectRegisteredClaimHash(
        bytes32 expectedClaimHash,
        bytes32 registeredClaimHash
    );
    error FillDeadlinePassed(uint32 deadline);
    error CompactExpiryPassed(uint32 expiry);
    error AssetIdsDoNotMatch();
    error ReceiverDoNotMatch();

    /// Storage ///

    /// @dev TheCompact, the escrow contract used for Catalyst.
    ITheCompact public immutable COMPACT;
    /// @dev Catalyst Compact Settler, containg logic for collecting assets from COMPACT.
    address public immutable CATALYST_COMPACT_SETTLER;

    /// Types ///

    /// @param receiverAddress The destination account for the delivered assets and calldata.
    /// @param assetId Input token. The leftmost 12 bytes is the lockTag and the
    /// rightmost 20 is the address of the token which needs to be equal to the inputAssetId.
    /// @param expectedClaimHash Security check. If provided, it needs to match the returned claim hash from TheCompact
    /// @param user The deposit and claim registration will be made in this user's name.
    /// Compact 6909 tokens will be minted for this user and if the intent fails to be filled
    /// the tokens will remain in this user's name.
    /// @param expiry If the proof for the fill does not arrive before this time, the claim expires.
    /// @param fillDeadline The fill has to happen before this time.
    /// @param localOracle Address of the validation layer used on the sending chain.
    /// @param remoteOracle Address of the validation layer used on the remote chain.
    /// @param remoteFiller Address of the output settlement contract containing the fill logic.
    /// @param outputToken The desires destination token.
    /// @param outputAmount The amount of the destired token.
    /// @param remoteCall Calldata to be executed after the token has been delivered. Is called on receiverAddress.
    /// if set to 0x / hex"" no call is made.
    /// @param fulfillmentContext Context for the remoteFiller to identify the order type.
    struct CatalystData {
        /// And calldata.
        bytes32 receiverAddress;
        uint256 assetId;
        bytes32 expectedClaimHash;
        address user;
        uint256 nonce;
        uint32 expiry;
        // Catalyst Witness //
        uint32 fillDeadline;
        address localOracle;
        // Catalyst Output //
        bytes32 remoteOracle;
        bytes32 remoteFiller;
        bytes32 outputToken;
        uint256 outputAmount;
        bytes remoteCall;
        bytes fulfillmentContext;
    }

    /// Event ///

    event Deposited(CatalystCompactOrder order);

    /// Constructor ///

    /// @param compact The Compact delopment, used as a deposit escrow.
    /// @param compactSettler Catalyst Compact arbiter / settlement implementation.
    constructor(address compact, address compactSettler) {
        COMPACT = ITheCompact(compact);
        CATALYST_COMPACT_SETTLER = compactSettler;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Catalyst
    /// @param _bridgeData The core information needed for bridging
    /// @param _catalystData Data specific to Catalyst
    function startBridgeTokensViaCatalyst(
        ILiFi.BridgeData memory _bridgeData,
        CatalystData calldata _catalystData
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
        _startBridge(_bridgeData, _catalystData);
    }

    /// @notice Performs a swap before bridging via Catalyst
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _catalystData Data specific to Catalyst
    function swapAndStartBridgeTokensViaCatalyst(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CatalystData calldata _catalystData
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
        _startBridge(_bridgeData, _catalystData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Catalyst
    /// @param _bridgeData The core information needed for bridging
    /// @param _catalystData Data specific to Catalyst
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CatalystData calldata _catalystData
    ) internal {
        // Check if theCompact and inputAssetId is the same token.
        // Both LI.Fi and theCompact uses address(0) for native token.
        if (
            asSanitizedAddress(_catalystData.assetId) !=
            _bridgeData.sendingAssetId
        ) revert AssetIdsDoNotMatch();

        // Check if the receiver is the same according to bridgeData and catalystData
        if (
            asSanitizedAddress(uint256(_catalystData.receiverAddress)) !=
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
        idsAndAmounts[0] = [_catalystData.assetId, amount];

        OutputDescription[] memory outputs = new OutputDescription[](1);
        outputs[0] = OutputDescription({
            remoteOracle: _catalystData.remoteOracle,
            remoteFiller: _catalystData.remoteFiller,
            chainId: _bridgeData.destinationChainId,
            token: _catalystData.outputToken,
            amount: _catalystData.outputAmount,
            recipient: _catalystData.receiverAddress,
            remoteCall: _catalystData.remoteCall,
            fulfillmentContext: _catalystData.fulfillmentContext
        });

        // Check if the fill deadline has been passed.
        if (block.timestamp > _catalystData.fillDeadline)
            revert FillDeadlinePassed(_catalystData.fillDeadline);

        if (block.timestamp > _catalystData.expiry)
            revert FillDeadlinePassed(_catalystData.expiry);

        // Make the deposit on behalf of the user. We register the claim with the tokens
        // the claim claims.
        bytes32 registeredClaimHash = COMPACT.depositAndRegisterFor{
            value: LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
                ? amount
                : 0
        }(
            _catalystData.user, // If the transaction fails, this will be who receives the
            idsAndAmounts, // The amounts registered for theCompact.
            CATALYST_COMPACT_SETTLER, // Arbiter. Calling theCompact to send the asset to the solver.
            _catalystData.nonce, // Unique allocator nonce to differentiate transactions.
            _catalystData.expiry, // Expiry of the intent.
            TheCompactOrderType.CATALYST_BATCH_COMPACT_TYPE_HASH, // 712 typehash for the entire claim, including witness
            TheCompactOrderType.witnessHash(
                _catalystData.fillDeadline,
                _catalystData.localOracle,
                outputs
            ) // Catalyst witness hash.
        );

        // Check if the returned claimHash matches the claim hash we expected.
        bytes32 expectedClaimHash = _catalystData.expectedClaimHash;
        if (
            expectedClaimHash != 0 && registeredClaimHash != expectedClaimHash
        ) {
            revert IncorrectRegisteredClaimHash(
                registeredClaimHash,
                expectedClaimHash
            );
        }

        // Emit the transaction so it can be found on-chain.
        emit Deposited(
            CatalystCompactOrder({
                user: _catalystData.user,
                nonce: _catalystData.nonce,
                originChainId: block.chainid,
                expires: _catalystData.expiry,
                fillDeadline: _catalystData.fillDeadline,
                localOracle: _catalystData.localOracle,
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
