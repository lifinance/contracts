// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { ECDSA } from "solady/utils/ECDSA.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title RelayFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Relay Protocol
/// @custom:version 1.0.2
contract RelayFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    /// @notice Namespace for diamond storage
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.relay");

    /// Immutables ///

    /// @dev Receiver for native transfers
    address internal immutable RELAY_RECEIVER;

    /// @dev Relayer wallet for ERC20 transfers
    address internal immutable RELAY_SOLVER;

    /// Storage ///

    /// @dev [BACKWARD COMPATIBILITY] Legacy consumedIds mapping at slot 0.
    /// In previous versions, this was the first (and only) storage variable,
    /// therefore occupying slot 0 in the diamond when executed via delegatecall.
    /// We only read from this mapping to preserve replay-protection after upgrades.
    // solhint-disable-next-line var-name-mixedcase
    mapping(bytes32 => bool) private DEPRECATED_consumedIds;

    /// Diamond Storage ///

    /// @notice Diamond storage structure (minimal - only replay protection)
    struct Storage {
        /// @dev Mapping to prevent duplicate quote usage (requestId => consumed)
        mapping(bytes32 => bool) consumedIds;
    }

    /// Types ///

    /// @dev Relay specific parameters
    /// @param requestId Relay API request ID
    /// @param nonEVMReceiver set only if bridging to non-EVM chain
    /// @param receivingAssetId address of receiving asset
    /// @param signature attestation signature provided by the Relay solver
    struct RelayData {
        bytes32 requestId;
        bytes32 nonEVMReceiver;
        bytes32 receivingAssetId;
        bytes signature;
    }

    /// Errors ///

    error InvalidQuote();

    /// Modifiers ///

    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    modifier onlyValidQuote(
        ILiFi.BridgeData memory _bridgeData,
        RelayData calldata _relayData
    ) {
        // Ensure that the id isn't already consumed
        if (
            getStorage().consumedIds[_relayData.requestId] ||
            DEPRECATED_consumedIds[_relayData.requestId]
        ) {
            revert InvalidQuote();
        }

        // Ensure nonEVMAddress is not empty
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _relayData.nonEVMReceiver == bytes32(0)
        ) {
            revert InvalidNonEVMReceiver();
        }

        // Verify that the bridging quote has been signed by the Relay solver
        // as attested using the attestation API
        // API URL: https://api.relay.link/requests/{requestId}/signature/v2
        bytes32 message = ECDSA.toEthSignedMessageHash(
            keccak256(
                abi.encodePacked(
                    _relayData.requestId,
                    block.chainid,
                    bytes32(uint256(uint160(address(this)))),
                    bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                    _getMappedChainId(_bridgeData.destinationChainId),
                    _bridgeData.receiver == NON_EVM_ADDRESS
                        ? _relayData.nonEVMReceiver
                        : bytes32(uint256(uint160(_bridgeData.receiver))),
                    _relayData.receivingAssetId
                )
            )
        );
        address signer = ECDSA.recover(message, _relayData.signature);
        if (signer != RELAY_SOLVER) {
            revert InvalidQuote();
        }
        _;
    }

    /// Constructor ///

    /// @param _relayReceiver The receiver for native transfers
    /// @param _relaySolver The relayer wallet for ERC20 transfers
    constructor(address _relayReceiver, address _relaySolver) {
        if (_relayReceiver == address(0) || _relaySolver == address(0)) {
            revert InvalidConfig();
        }

        RELAY_RECEIVER = _relayReceiver;
        RELAY_SOLVER = _relaySolver;
    }

    /// External Methods ///

    /// @notice Returns whether a requestId has already been consumed (replay protection)
    /// @param requestId Relay API request ID
    /// @return True if already consumed
    function consumedIds(bytes32 requestId) external view returns (bool) {
        return
            getStorage().consumedIds[requestId] ||
            DEPRECATED_consumedIds[requestId];
    }

    /// @notice Bridges tokens via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    function startBridgeTokensViaRelay(
        ILiFi.BridgeData calldata _bridgeData,
        RelayData calldata _relayData
    )
        external
        payable
        nonReentrant
        onlyValidQuote(_bridgeData, _relayData)
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _relayData);
    }

    /// @notice Performs a swap before bridging via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _relayData Data specific to Relay
    function swapAndStartBridgeTokensViaRelay(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        RelayData calldata _relayData
    )
        external
        payable
        nonReentrant
        onlyValidQuote(_bridgeData, _relayData)
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
        _startBridge(_bridgeData, _relayData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Relay
    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        RelayData calldata _relayData
    ) internal {
        // check if sendingAsset is native or ERC20
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native

            // Send Native to relayReceiver along with requestId as extra data
            (bool success, bytes memory reason) = RELAY_RECEIVER.call{
                value: _bridgeData.minAmount
            }(abi.encode(_relayData.requestId));
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        } else {
            // ERC20

            // We build the calldata from scratch to ensure that we can only
            // send to the solver address
            bytes memory transferCallData = bytes.concat(
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    RELAY_SOLVER,
                    _bridgeData.minAmount
                ),
                abi.encode(_relayData.requestId)
            );
            (bool success, bytes memory reason) = address(
                _bridgeData.sendingAssetId
            ).call(transferCallData);
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        }

        getStorage().consumedIds[_relayData.requestId] = true;

        // Emit special event if bridging to non-EVM chain
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _getMappedChainId(_bridgeData.destinationChainId),
                _relayData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice get Relay specific chain id for non-EVM chains
    ///         IDs found here  https://li.quest/v1/chains?chainTypes=UTXO,SVM
    /// @param chainId LIFI specific chain id
    function _getMappedChainId(
        uint256 chainId
    ) internal pure returns (uint256) {
        // Bitcoin
        if (chainId == 20000000000001) {
            return 8253038;
        }

        // Solana
        if (chainId == 1151111081099710) {
            return 792703809;
        }

        return chainId;
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
