// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { ECDSA } from "solady/utils/ECDSA.sol";

/// @title Relay Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Relay Protocol
/// @custom:version 1.0.0
contract RelayFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    // Receiver for native transfers
    address public immutable relayReceiver;
    // Relayer wallet for ERC20 transfers
    address public immutable relaySolver;

    /// Types ///

    /// @dev Relay specific parameters
    /// @param requestId Realy API request ID
    /// @param nonEVMReceiver set only if bridging to non-EVM chain
    /// @params receivingAssetId address of receiving asset
    /// @params callData calldata provided by Relay API
    /// @params signature attestation signature provided by the Relay solver
    struct RelayData {
        bytes32 requestId;
        bytes32 nonEVMReceiver;
        bytes32 receivingAssetId;
        bytes callData;
        bytes signature;
    }

    /// Events ///

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes32 receiver
    );

    /// Errors ///

    error InvalidQuote();

    /// Modifiers ///

    /// @param _bridgeData The core information needed for bridging
    /// @param _relayData Data specific to Relay
    modifier onlyValidQuote(
        ILiFi.BridgeData memory _bridgeData,
        RelayData calldata _relayData
    ) {
        // Verify that the bridging quote has been signed by the Relay solver
        // as attested using the attestaion API
        // API URL: https://api.relay.link/requests/{requestId}/signature/v2
        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
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
            )
        );
        address signer = ECDSA.recover(message, _relayData.signature);
        if (signer != relaySolver) {
            revert InvalidQuote();
        }
        _;
    }

    /// Constructor ///

    constructor(address _relayReceiver, address _relaySolver) {
        relayReceiver = _relayReceiver;
        relaySolver = _relaySolver;
    }

    /// External Methods ///

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
            (bool success, bytes memory reason) = relayReceiver.call{
                value: _bridgeData.minAmount
            }(abi.encode(_relayData.requestId));
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        } else {
            bytes memory quoteId = _relayData.callData[68:];
            // ERC20

            // We build the calldata from scratch to ensure that we can only
            // send to the solver address
            bytes memory transferCallData = bytes.concat(
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    relaySolver,
                    _bridgeData.minAmount
                ),
                quoteId
            );
            (bool success, bytes memory reason) = address(
                _bridgeData.sendingAssetId
            ).call(transferCallData);
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        }

        // Emit special event if bridging to non-EVM chain
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _relayData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice get Relay specific chain id for non-EVM chains
    /// @param chainId LIFI specific chain id
    function _getMappedChainId(
        uint256 chainId
    ) internal pure returns (uint256) {
        if (chainId == 20000000000001) {
            return 8253038;
        }

        if (chainId == 1151111081099710) {
            return 792703809;
        }

        return chainId;
    }
}
