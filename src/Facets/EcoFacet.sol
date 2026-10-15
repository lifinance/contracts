// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import { ReentrancyGuard } from "lifi/Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "lifi/Helpers/SwapperV2.sol";
import { Validatable } from "lifi/Helpers/Validatable.sol";
import { LiFiData } from "lifi/Helpers/LiFiData.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { InvalidCallData, InvalidConfig, InvalidReceiver, InvalidNonEVMReceiver, InvalidSignature } from "lifi/Errors/GenericErrors.sol";

/// @title EcoFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Eco Protocol
/// @dev The `encodedRoute`, `intentDestination` and `prover` are opaque,
///      backend-supplied parameters whose contents the facet does not
///      validate on-chain: the route encodes destination calls the facet does
///      not interpret (a CCTP burn, a HyperCore deposit, a second Eco intent),
///      `intentDestination` is the Eco chain ID the route executes on (the
///      source chain for CCTP routes, HyperEVM for HyperCore), and a
///      malicious prover could mark an intent fulfilled without paying out.
///      All three are gated by a backend EIP-712 signature (see
///      `_verifySignature`) that commits to the bridge parameters, the prover,
///      the intent destination and a hash of the encoded route. For EVM
///      destinations the receiver is therefore enforced only by the backend
///      signature, not on-chain. For Solana and Tron the facet additionally
///      checks that the route pays `nonEVMReceiver`/`solanaATA`.
///      This contract is not intended to custody user funds; any balance is
///      transient within a single transaction.
/// @custom:version 3.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Errors ///

    error IntentAlreadyFunded();
    /// @notice Thrown when the backend signature has expired
    error SignatureExpired();

    /// Constants and Immutables ///

    IEcoPortal public immutable PORTAL;
    /// @notice Backend signer authorized to sign the EcoPayload
    address internal immutable BACKEND_SIGNER;

    // EIP-712 typehash: keccak256("EcoPayload(bytes32 transactionId,address sendingAssetId,uint256 minAmount,uint256 destinationChainId,address receiver,bytes32 nonEVMReceiverHash,uint64 intentDestination,bytes32 encodedRouteHash,address prover,address refundRecipient,uint64 rewardDeadline,bytes32 solanaATA,uint256 deadline)")
    bytes32 private constant ECO_PAYLOAD_TYPEHASH =
        0x5eab41fdaef699ef7c6516a09842972b29e6319a531c00a7f90ab2292d78d9d8;

    /// Constants ///

    uint256 private constant NATIVE_REWARD_AMOUNT = 0;
    bool private constant ALLOW_PARTIAL_FILL = false;
    uint256 private constant SOLANA_ENCODED_ROUTE_LENGTH = 319;
    uint256 private constant SOLANA_RECEIVER_OFFSET = 251;
    uint256 private constant SOLANA_RECEIVER_END = 283;
    uint256 private constant SOLANA_ADDRESS_MIN_LENGTH = 32;
    uint256 private constant SOLANA_ADDRESS_MAX_LENGTH = 44;
    /// @dev `transfer(address,uint256)`: 4-byte selector plus two words
    uint256 private constant TRANSFER_CALL_LENGTH = 68;

    /// Types ///

    /// @notice Defines the routing and execution instructions for cross-chain messages
    /// @dev Contains all necessary information to route and execute a message on the destination chain
    /// @param salt Unique identifier provided by the intent creator, used to prevent duplicates
    /// @param deadline Timestamp by which the route must be executed
    /// @param portal Address of the portal contract on the destination chain that receives messages
    /// @param nativeAmount Amount of native tokens to send with the route execution
    /// @param tokens Array of tokens required for execution of calls on destination chain
    /// @param calls Array of contract calls to execute on the destination chain in sequence
    struct Route {
        bytes32 salt;
        uint64 deadline;
        address portal;
        uint256 nativeAmount;
        IEcoPortal.TokenAmount[] tokens;
        Call[] calls;
    }

    /// @notice Represents a single contract call to be executed
    /// @dev Used within Route to define execution sequence
    /// @param target Address of the contract to call
    /// @param data Encoded function call data
    /// @param value Native value sent with the call
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    /// @dev Eco specific parameters
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param intentDestination Eco chain ID the route executes on, which
    ///        differs from `bridgeData.destinationChainId` for CCTP (source
    ///        chain), HyperCore (HyperEVM), Solana and Tron routes
    /// @param encodedRoute Encoded route data containing destination chain routing information
    /// @param solanaATA Associated Token Account address for Solana bridging (bytes32)
    /// @param refundRecipient Address that receives source-chain leftovers and
    ///        the reward refund if the intent expires unfulfilled
    /// @param deadline Timestamp after which the backend signature is no longer valid
    /// @param signature Backend EIP-712 signature over the EcoPayload authorizing this bridge
    struct EcoData {
        bytes nonEVMReceiver;
        address prover;
        uint64 rewardDeadline;
        uint64 intentDestination;
        bytes encodedRoute;
        bytes32 solanaATA;
        address refundRecipient;
        uint256 deadline;
        bytes signature;
    }

    /// Constructor ///

    /// @notice Initializes the EcoFacet with the Eco Portal contract
    /// @param _portal Address of the Eco Portal contract
    /// @param _backendSigner Address of the backend signer authorized to sign the EcoPayload
    constructor(IEcoPortal _portal, address _backendSigner) {
        if (address(_portal) == address(0) || _backendSigner == address(0)) {
            revert InvalidConfig();
        }
        PORTAL = _portal;
        BACKEND_SIGNER = _backendSigner;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Eco Protocol
    /// @param _bridgeData Bridge data containing core parameters
    /// @param _ecoData Eco-specific parameters for the bridge
    function startBridgeTokensViaEco(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    )
        external
        nonReentrant
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _verifySignature(_bridgeData, _ecoData);
        _validateEcoData(_bridgeData, _ecoData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _ecoData);
    }

    /// @notice Swaps and bridges tokens via Eco Protocol
    /// @param _bridgeData Bridge data containing core parameters
    /// @param _swapData Array of swap data for source swaps
    /// @param _ecoData Eco-specific parameters for the bridge
    function swapAndStartBridgeTokensViaEco(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        EcoData calldata _ecoData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_ecoData.refundRecipient))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        // The signature is intentionally verified with the pre-swap `minAmount`,
        // which is also the amount funded into the reward in `_startBridge`.
        _verifySignature(_bridgeData, _ecoData);
        _validateEcoData(_bridgeData, _ecoData);

        uint256 actualAmountAfterSwap = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_ecoData.refundRecipient)
        );

        if (actualAmountAfterSwap > _bridgeData.minAmount) {
            uint256 positiveSlippage = actualAmountAfterSwap -
                _bridgeData.minAmount;
            LibAsset.transferERC20(
                _bridgeData.sendingAssetId,
                payable(_ecoData.refundRecipient),
                positiveSlippage
            );
        }

        _startBridge(_bridgeData, _ecoData);
    }

    /// Internal Methods ///

    function _buildReward(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        uint256 totalAmount
    ) private pure returns (IEcoPortal.Reward memory) {
        IEcoPortal.TokenAmount[]
            memory rewardTokens = new IEcoPortal.TokenAmount[](1);
        rewardTokens[0] = IEcoPortal.TokenAmount({
            token: _bridgeData.sendingAssetId,
            amount: totalAmount
        });

        return
            IEcoPortal.Reward({
                creator: _ecoData.refundRecipient,
                prover: _ecoData.prover,
                deadline: _ecoData.rewardDeadline,
                nativeAmount: NATIVE_REWARD_AMOUNT,
                tokens: rewardTokens
            });
    }

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        uint256 totalAmount = _bridgeData.minAmount;

        IEcoPortal.Reward memory reward = _buildReward(
            _bridgeData,
            _ecoData,
            totalAmount
        );

        bytes32 intentHash = _getIntentHash(
            _ecoData.intentDestination,
            _ecoData.encodedRoute,
            reward
        );

        if (PORTAL.getRewardStatus(intentHash) != IEcoPortal.Status.Initial) {
            revert IntentAlreadyFunded();
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(PORTAL),
            totalAmount
        );

        PORTAL.publishAndFund(
            _ecoData.intentDestination,
            _ecoData.encodedRoute,
            reward,
            ALLOW_PARTIAL_FILL
        );

        if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _ecoData.nonEVMReceiver
            );
        } else if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_TRON) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                bytes32(_ecoData.nonEVMReceiver[0:32])
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private view {
        if (_ecoData.prover == address(0)) revert InvalidConfig();
        if (_ecoData.refundRecipient == address(0)) revert InvalidCallData();
        if (_ecoData.rewardDeadline <= block.timestamp) {
            revert InvalidConfig();
        }
        if (_ecoData.encodedRoute.length == 0) revert InvalidConfig();

        bool isSolanaDestination = _bridgeData.destinationChainId ==
            LIFI_CHAIN_ID_SOLANA;
        bool isTronDestination = _bridgeData.destinationChainId ==
            LIFI_CHAIN_ID_TRON;

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (isSolanaDestination) {
                if (_ecoData.nonEVMReceiver.length == 0)
                    revert InvalidReceiver();
                if (_ecoData.solanaATA == bytes32(0)) revert InvalidConfig();
                if (
                    _ecoData.encodedRoute.length != SOLANA_ENCODED_ROUTE_LENGTH
                ) revert InvalidReceiver();
                _validateSolanaReceiver(_ecoData);
            } else if (isTronDestination) {
                if (_ecoData.nonEVMReceiver.length != 32)
                    revert InvalidReceiver();
                _validateTronReceiver(_ecoData);
            } else {
                revert InvalidConfig();
            }
        } else if (isSolanaDestination || isTronDestination) {
            // Non-EVM chains must use the NON_EVM_ADDRESS sentinel path above
            revert InvalidReceiver();
        }
    }

    /// @dev Tron uses the same Route struct encoding as EVM chains, so the real
    ///      recipient lives in the route. nonEVMReceiver carries that recipient
    ///      as a 32-byte left-padded address and must receive the route's final
    ///      TRC20 `transfer`.
    function _validateTronReceiver(EcoData calldata _ecoData) private pure {
        bytes32 nonEVMReceiver = bytes32(_ecoData.nonEVMReceiver[0:32]);
        if (LibBytes.toAddress(nonEVMReceiver) == address(0)) {
            revert InvalidNonEVMReceiver();
        }

        Route memory route = abi.decode(_ecoData.encodedRoute, (Route));
        if (route.calls.length == 0) revert InvalidReceiver();
        bytes memory lastCallData = route.calls[route.calls.length - 1].data;
        if (lastCallData.length < TRANSFER_CALL_LENGTH) {
            revert InvalidReceiver();
        }

        bytes32 recipient;
        // Memory `bytes` cannot be sliced, so the first argument is read
        // directly: skip the 32-byte length prefix and the 4-byte selector
        assembly {
            recipient := mload(add(lastCallData, 36))
        }
        if (
            bytes4(lastCallData) != IERC20.transfer.selector ||
            recipient != nonEVMReceiver
        ) revert InvalidReceiver();
    }

    function _validateSolanaReceiver(EcoData calldata _ecoData) private pure {
        // Validate the nonEVMReceiver length for Solana addresses
        // Solana addresses are base58-encoded and should be between 32-44 characters
        if (
            _ecoData.nonEVMReceiver.length < SOLANA_ADDRESS_MIN_LENGTH ||
            _ecoData.nonEVMReceiver.length > SOLANA_ADDRESS_MAX_LENGTH
        ) {
            revert InvalidReceiver();
        }

        // Extract the Associated Token Account (ATA) from the Borsh-encoded Route struct
        // The Route struct contains TransferChecked instruction calldata where:
        // - The entire Route struct is Borsh-serialized
        // - Within the serialized Route, the TransferChecked instruction data is embedded
        // - The destination ATA address is located at bytes 251-283 (32 bytes)
        // - This position is determined by the Route struct layout and the position of the
        //   ATA pubkey within the TransferChecked instruction calldata
        // - Borsh encoding preserves the exact byte positions for fixed-size fields like pubkeys
        // - The total encoded route for Solana must be exactly 319 bytes
        // Extract bytes 251-283 (32 bytes) which contain the destination ATA
        bytes32 routeReceiver = bytes32(
            _ecoData.encodedRoute[SOLANA_RECEIVER_OFFSET:SOLANA_RECEIVER_END]
        );

        // Validate that the provided solanaATA matches the recipient in the encoded route
        if (_ecoData.solanaATA != routeReceiver) {
            revert InvalidReceiver();
        }
    }

    function _getIntentHash(
        uint64 destination,
        bytes calldata route,
        IEcoPortal.Reward memory reward
    ) private pure returns (bytes32) {
        bytes32 routeHash = keccak256(route);
        bytes32 rewardHash = keccak256(abi.encode(reward));
        return keccak256(abi.encodePacked(destination, routeHash, rewardHash));
    }

    /// @dev Verifies the backend EIP-712 signature over the EcoPayload. The
    ///      opaque `encodedRoute` and `nonEVMReceiver` are committed via their
    ///      keccak256 hashes.
    /// @param _bridgeData The core information needed for bridging
    /// @param _ecoData Eco-specific parameters for the bridge
    function _verifySignature(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal view {
        if (block.timestamp > _ecoData.deadline) {
            revert SignatureExpired();
        }

        bytes32 structHash = keccak256(
            abi.encode(
                ECO_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                keccak256(_ecoData.nonEVMReceiver),
                _ecoData.intentDestination,
                keccak256(_ecoData.encodedRoute),
                _ecoData.prover,
                _ecoData.refundRecipient,
                _ecoData.rewardDeadline,
                _ecoData.solanaATA,
                _ecoData.deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        address recoveredSigner = ECDSA.recoverCalldata(
            digest,
            _ecoData.signature
        );

        if (recoveredSigner != BACKEND_SIGNER) {
            revert InvalidSignature();
        }
    }

    /// @notice Returns the EIP-712 domain separator
    /// @dev Computed on the fly so `address(this)` resolves to the
    ///      diamond's address when called via delegatecall
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI Eco Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }
}
