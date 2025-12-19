// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title NEARIntentsFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through NEAR Intents Protocol
/// @notice WARNING: This facet does NOT support fee-on-transfer tokens (e.g., SafeMoon, PAXG).
///         Using such tokens will result in the quote ID being consumed without proper bridging,
///         as the contract does not validate destination balances after transfer.
/// @custom:version 1.0.0
contract NEARIntentsFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    /// @notice Namespace for diamond storage
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.nearintents");

    // EIP-712 typehash for NEARIntentsPayload: keccak256("NEARIntentsPayload(bytes32 transactionId,uint256 minAmount,bytes32 receiver,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline,bytes32 quoteId,uint256 minAmountOut)");
    bytes32 private constant NEARINTENTS_PAYLOAD_TYPEHASH =
        0x26e3f312476209e792e713eef13bd95c5da5292aba26e299c7d8e7c647d7903e;

    /// @notice The address of the backend signer that is authorized to sign the NEARIntentsPayload
    address internal immutable BACKEND_SIGNER;

    /// Types ///

    /// @notice NEAR Intents specific parameters
    /// @param nonEVMReceiver Set only if bridging to non-EVM chain (e.g., NEAR account ID) - receiver field per convention
    /// @param depositAddress EVM address to send tokens (from Bridge API) - receiver field per convention
    /// @param quoteId Unique identifier from 1Click API quote response
    /// @param deadline Unix timestamp when quote expires (refunds begin if unfulfilled)
    /// @param minAmountOut Minimum output amount on destination (slippage protection)
    /// @param refundRecipient Address that will receive positive slippage from swaps
    /// @param signature The signature of the NEARIntentsPayload signed by the backend signer using EIP-712 standard
    struct NEARIntentsData {
        bytes32 nonEVMReceiver;
        address depositAddress;
        bytes32 quoteId;
        uint256 deadline;
        uint256 minAmountOut;
        address refundRecipient;
        bytes signature;
    }

    /// Storage ///

    /// @notice Diamond storage structure (minimal - only replay protection)
    struct Storage {
        /// @dev Mapping to prevent duplicate quote usage (quoteId => consumed)
        mapping(bytes32 => bool) consumedQuoteIds;
    }

    /// Events ///

    /// @notice Emitted when a bridge operation starts via NEAR Intents
    /// @notice Required by NEAR off-chain infrastructure to track deposits and initiate intent settlement
    /// @param transactionId Unique transaction identifier
    /// @param quoteId NEAR Intents quote identifier
    /// @param depositAddress Address tokens were sent to
    /// @param sendingAssetId Token being bridged
    /// @param amount Amount being bridged
    /// @param deadline Quote expiration timestamp
    /// @param minAmountOut Minimum amount expected on destination chain (slippage protection from NEAR Intents)
    event NEARIntentsBridgeStarted(
        bytes32 indexed transactionId,
        bytes32 indexed quoteId,
        address indexed depositAddress,
        address sendingAssetId,
        uint256 amount,
        uint256 deadline,
        uint256 minAmountOut
    );

    /// Errors ///

    /// @notice Thrown when trying to use a quote that was already consumed
    error QuoteAlreadyConsumed();

    /// @notice Thrown when the quote deadline has passed
    error QuoteExpired();

    /// @notice Thrown when the signature is invalid
    error InvalidSignature();

    /// Constructor ///

    /// @notice Initializes the NEARIntentsFacet contract
    /// @param _backendSigner The address of the backend signer
    constructor(address _backendSigner) {
        if (_backendSigner == address(0)) {
            revert InvalidConfig();
        }
        BACKEND_SIGNER = _backendSigner;
    }

    /// Modifiers ///

    /// @dev Validates quote parameters (consolidated from separate helper function)
    /// @param _bridgeData The core information needed for bridging
    /// @param _nearData Data specific to NEAR Intents
    modifier onlyValidQuote(
        ILiFi.BridgeData memory _bridgeData,
        NEARIntentsData calldata _nearData
    ) {
        Storage storage s = getStorage();

        // Prevent replay attacks
        if (s.consumedQuoteIds[_nearData.quoteId]) {
            revert QuoteAlreadyConsumed();
        }

        // Ensure quote hasn't expired
        if (block.timestamp > _nearData.deadline) {
            revert QuoteExpired();
        }

        // Ensure nonEVMReceiver is not empty when bridging to non-EVM chain
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _nearData.nonEVMReceiver == bytes32(0)
        ) {
            revert InvalidNonEVMReceiver();
        }

        _;
    }

    /// External Methods ///

    /// @notice Bridges tokens via NEAR Intents
    /// @param _bridgeData The core information needed for bridging
    /// @param _nearData Data specific to NEAR Intents
    function startBridgeTokensViaNEARIntents(
        ILiFi.BridgeData calldata _bridgeData,
        NEARIntentsData calldata _nearData
    )
        external
        payable
        nonReentrant
        onlyValidQuote(_bridgeData, _nearData)
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _verifySignature(_bridgeData, _nearData);
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _nearData);
    }

    /// @notice Performs a swap before bridging via NEAR Intents
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps
    /// @param _nearData Data specific to NEAR Intents
    function swapAndStartBridgeTokensViaNEARIntents(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        NEARIntentsData calldata _nearData
    )
        external
        payable
        nonReentrant
        onlyValidQuote(_bridgeData, _nearData)
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _verifySignature(_bridgeData, _nearData);

        uint256 actualAmountAfterSwap = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        if (actualAmountAfterSwap > _bridgeData.minAmount) {
            uint256 positiveSlippage = actualAmountAfterSwap -
                _bridgeData.minAmount;
            LibAsset.transferAsset(
                _bridgeData.sendingAssetId,
                payable(_nearData.refundRecipient),
                positiveSlippage
            );
        }

        _startBridge(_bridgeData, _nearData);
    }

    /// View Functions ///

    /// @notice Check if a quote has been consumed
    /// @param _quoteId The quote ID to check
    /// @return consumed Whether the quote has been used
    function isQuoteConsumed(
        bytes32 _quoteId
    ) external view returns (bool consumed) {
        return getStorage().consumedQuoteIds[_quoteId];
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for bridging via NEAR Intents
    /// @param _bridgeData The core information needed for bridging
    /// @param _nearData Data specific to NEAR Intents
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        NEARIntentsData calldata _nearData
    ) internal {
        Storage storage s = getStorage();

        // Mark quote as consumed BEFORE external interactions (CEI pattern)
        s.consumedQuoteIds[_nearData.quoteId] = true;

        // Transfer tokens to the deposit address generated by Bridge API
        LibAsset.transferAsset(
            _bridgeData.sendingAssetId,
            payable(_nearData.depositAddress),
            _bridgeData.minAmount
        );

        // Emit bridge started event
        emit NEARIntentsBridgeStarted(
            _bridgeData.transactionId,
            _nearData.quoteId,
            _nearData.depositAddress,
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _nearData.deadline,
            _nearData.minAmountOut
        );

        // Emit special event if bridging to non-EVM chain
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _nearData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Verifies the EIP-712 signature
    /// @param _bridgeData The core information needed for bridging
    /// @param _nearData Data specific to NEAR Intents
    function _verifySignature(
        ILiFi.BridgeData memory _bridgeData,
        NEARIntentsData calldata _nearData
    ) internal view {
        bytes32 receiverBytes32 = _bridgeData.receiver == NON_EVM_ADDRESS
            ? _nearData.nonEVMReceiver
            : bytes32(uint256(uint160(_bridgeData.receiver)));

        bytes32 structHash = keccak256(
            abi.encode(
                NEARINTENTS_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.minAmount,
                receiverBytes32,
                _nearData.depositAddress,
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                _nearData.deadline,
                _nearData.quoteId,
                _nearData.minAmountOut
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        address recoveredSigner = ECDSA.recover(digest, _nearData.signature);

        if (recoveredSigner != BACKEND_SIGNER) {
            revert InvalidSignature();
        }
    }

    /// @notice Returns the EIP-712 domain separator.
    /// @dev The domain separator is calculated on the fly to ensure that `address(this)`
    /// always refers to the diamond's address when called via delegatecall.
    /// @return The EIP-712 domain separator.
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI NEAR Intents Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this) // This will be the diamond's address at runtime
                )
            );
    }

    /// Private Methods ///

    /// @dev Gets the diamond storage for this facet
    /// @return s The storage struct
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
