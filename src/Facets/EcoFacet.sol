// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IEcoPortal } from "../Interfaces/IEcoPortal.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { InvalidConfig, InvalidReceiver, InvalidNonEVMReceiver, InvalidSignature } from "../Errors/GenericErrors.sol";

/// @title EcoFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Eco Protocol
/// @dev The `encodedRoute` and `prover` are opaque, backend-supplied parameters
///      whose full contents cannot be reconstructed and validated on-chain (the
///      route encodes destination calls the facet does not interpret, and a
///      malicious prover could mark an intent fulfilled without paying out). Both
///      are therefore gated by a backend EIP-712 signature (see `_verifySignature`)
///      that commits to the bridge parameters, the prover, and a hash of the
///      encoded route. The on-chain receiver cross-checks in `_validateEcoData`
///      are retained as defense in depth; integrators must understand that the
///      destination receiver is not purely enforced on-chain for these flows.
/// @custom:version 2.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Errors ///

    error IntentAlreadyFunded();
    /// @notice Thrown when the backend signature has expired
    error SignatureExpired();

    /// Constants and Immutables ///

    IEcoPortal public immutable PORTAL;
    /// @notice Backend signer authorized to sign the EcoPayload
    address internal immutable BACKEND_SIGNER;
    uint64 private constant ECO_CHAIN_ID_TRON = 728126428;
    uint64 private constant ECO_CHAIN_ID_SOLANA = 1399811149;

    // EIP-712 typehash: keccak256("EcoPayload(bytes32 transactionId,address sendingAssetId,uint256 minAmount,uint256 destinationChainId,address receiver,bytes32 nonEVMReceiverHash,bytes32 encodedRouteHash,address prover,address refundRecipient,uint64 rewardDeadline,bytes32 solanaATA,uint256 deadline)")
    bytes32 private constant ECO_PAYLOAD_TYPEHASH =
        0xa3243df568679887ffddc8c7d34cf0bd57b0a8d9430c7044d28def7369fd7881;

    /// Constants ///

    uint256 private constant NATIVE_REWARD_AMOUNT = 0;
    bool private constant ALLOW_PARTIAL_FILL = false;
    uint256 private constant SOLANA_ENCODED_ROUTE_LENGTH = 319;
    uint256 private constant SOLANA_RECEIVER_OFFSET = 251;
    uint256 private constant SOLANA_RECEIVER_END = 283;
    uint256 private constant SOLANA_ADDRESS_MIN_LENGTH = 32;
    uint256 private constant SOLANA_ADDRESS_MAX_LENGTH = 44;

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
    /// @param callData Encoded function call data
    struct Call {
        address target;
        bytes callData;
    }

    /// @dev Eco specific parameters
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param encodedRoute Encoded route data containing destination chain routing information
    /// @param solanaATA Associated Token Account address for Solana bridging (bytes32)
    /// @param refundRecipient Address that will receive refunds if the intent expires unfulfilled
    /// @param deadline Timestamp after which the backend signature is no longer valid
    /// @param signature Backend EIP-712 signature over the EcoPayload authorizing this bridge
    struct EcoData {
        bytes nonEVMReceiver;
        address prover;
        uint64 rewardDeadline;
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
    /// @dev TODO (next iteration): unused swap leftovers and excess native below are refunded
    ///      to msg.sender (which may be a relayer), not _ecoData.refundRecipient, unlike the
    ///      positive slippage refund further down, which already uses refundRecipient. Align
    ///      the two msg.sender-based refunds to refundRecipient as well.
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
        refundExcessNative(payable(msg.sender))
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
            payable(msg.sender)
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
    ) private view returns (IEcoPortal.Reward memory) {
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

        uint64 destination;
        if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_TRON) {
            destination = ECO_CHAIN_ID_TRON;
        } else if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            destination = ECO_CHAIN_ID_SOLANA;
        } else {
            if (_bridgeData.destinationChainId > type(uint64).max) {
                revert InvalidConfig();
            }
            destination = uint64(_bridgeData.destinationChainId);
        }

        bytes32 intentHash = _getIntentHash(
            destination,
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
            destination,
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
        if (_ecoData.refundRecipient == address(0)) revert InvalidConfig();
        if (_ecoData.rewardDeadline <= block.timestamp) {
            revert InvalidConfig();
        }

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
                if (_ecoData.encodedRoute.length == 0) revert InvalidConfig();
                if (_ecoData.nonEVMReceiver.length != 32)
                    revert InvalidReceiver();
                _validateTronReceiver(_ecoData);
            } else {
                revert InvalidConfig();
            }
        } else {
            if (_ecoData.encodedRoute.length == 0) revert InvalidConfig();

            // A concrete receiver is only valid for EVM destinations; non-EVM
            // chains must use the NON_EVM_ADDRESS sentinel path above.
            if (isSolanaDestination || isTronDestination) {
                revert InvalidReceiver();
            }

            if (
                _decodeRouteReceiver(_ecoData.encodedRoute) !=
                _bridgeData.receiver
            ) {
                revert InvalidReceiver();
            }
        }
    }

    /// @dev Decodes the Route struct and returns the recipient of its final
    ///      ERC20/TRC20 `transfer` call, the address the destination tokens are
    ///      sent to. Used to cross-check the caller-supplied receiver.
    function _decodeRouteReceiver(
        bytes calldata encodedRoute
    ) private pure returns (address routeReceiver) {
        Route memory route = abi.decode(encodedRoute, (Route));
        if (route.calls.length == 0) revert InvalidReceiver();

        // The last call must be a well-formed transfer(address,uint256): a
        // 4-byte selector + two 32-byte words. Enforcing the length and selector
        // before reading the address prevents a shorter or unrelated final call
        // from yielding a bogus receiver that still satisfies the cross-check.
        bytes memory lastCallData = route
            .calls[route.calls.length - 1]
            .callData;
        if (lastCallData.length < 68) revert InvalidReceiver();

        bytes4 selector;
        bytes32 receiverWord;
        assembly {
            selector := mload(add(lastCallData, 32))
            // Load the address word from offset 36 (32-byte length + 4-byte selector)
            receiverWord := mload(add(lastCallData, 36))
        }
        if (selector != IERC20.transfer.selector) revert InvalidReceiver();

        routeReceiver = LibBytes.toAddressUnchecked(receiverWord);
    }

    /// @dev Tron uses the same Route struct encoding as EVM chains, so the real
    ///      recipient lives in the route. nonEVMReceiver carries that recipient
    ///      as a 32-byte left-padded address and is cross-checked against it.
    function _validateTronReceiver(EcoData calldata _ecoData) private pure {
        address nonEVMReceiver = LibBytes.toAddress(
            bytes32(_ecoData.nonEVMReceiver[0:32])
        );
        if (nonEVMReceiver == address(0)) revert InvalidNonEVMReceiver();
        if (nonEVMReceiver != _decodeRouteReceiver(_ecoData.encodedRoute)) {
            revert InvalidReceiver();
        }
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
