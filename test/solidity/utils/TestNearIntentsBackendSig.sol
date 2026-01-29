// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LiFiData } from "src/Helpers/LiFiData.sol";
import { NEARIntentsFacet } from "lifi/Facets/NEARIntentsFacet.sol";
import { TestEIP712 } from "./TestEIP712.sol";

/// @title TestNearIntentsBackendSig
/// @notice Payload-specific signature helpers for `NEARIntentsFacet` tests.
abstract contract TestNearIntentsBackendSig is TestEIP712, LiFiData {
    // EIP-712 typehash for NEARIntentsPayload:
    // keccak256("NEARIntentsPayload(bytes32 transactionId,uint256 minAmount,bytes32 receiver,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline,bytes32 quoteId,uint256 minAmountOut)")
    bytes32 internal constant NEARINTENTS_PAYLOAD_TYPEHASH =
        0x26e3f312476209e792e713eef13bd95c5da5292aba26e299c7d8e7c647d7903e;

    string internal constant NEAR_DOMAIN_NAME = "LI.FI NEAR Intents Facet";
    string internal constant EIP712_VERSION = "1";

    /// @dev Set this to the diamond address (the verifyingContract used in the facet via delegatecall).
    address internal nearIntentsVerifyingContract;
    /// @dev Set this to the intended refund recipient used in test flows.
    address internal nearIntentsRefundRecipient;

    /// @dev Backend signer private key and derived address (tests typically configure these in `setUp()`).
    uint256 internal backendSignerPrivateKey;
    address internal backendSignerAddress;

    struct NEARIntentsPayload {
        bytes32 transactionId;
        uint256 minAmount;
        bytes32 receiver;
        address depositAddress;
        uint256 destinationChainId;
        address sendingAssetId;
        uint256 deadline;
        bytes32 quoteId;
        uint256 minAmountOut;
    }

    function _buildDomainSeparator(
        uint256 _chainId
    ) internal view returns (bytes32) {
        return
            _domainSeparator(
                NEAR_DOMAIN_NAME,
                EIP712_VERSION,
                _chainId,
                nearIntentsVerifyingContract
            );
    }

    function _buildStructHash(
        NEARIntentsPayload memory _payload
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    NEARINTENTS_PAYLOAD_TYPEHASH,
                    _payload.transactionId,
                    _payload.minAmount,
                    _payload.receiver,
                    _payload.depositAddress,
                    _payload.destinationChainId,
                    _payload.sendingAssetId,
                    _payload.deadline,
                    _payload.quoteId,
                    _payload.minAmountOut
                )
            );
    }

    function _createNEARIntentsPayload(
        ILiFi.BridgeData memory _bridgeData,
        address _depositAddress,
        uint256 _deadline,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        bytes32 _nonEvmReceiver
    ) internal pure returns (NEARIntentsPayload memory) {
        bytes32 receiverBytes32 = _bridgeData.receiver == NON_EVM_ADDRESS
            ? _nonEvmReceiver
            : bytes32(uint256(uint160(_bridgeData.receiver)));

        return
            NEARIntentsPayload({
                transactionId: _bridgeData.transactionId,
                minAmount: _bridgeData.minAmount,
                receiver: receiverBytes32,
                depositAddress: _depositAddress,
                destinationChainId: _bridgeData.destinationChainId,
                sendingAssetId: _bridgeData.sendingAssetId,
                deadline: _deadline,
                quoteId: _quoteId,
                minAmountOut: _minAmountOut
            });
    }

    function _generateValidNearDataWithPrivateKeyAndDeadline(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        bytes32 _nonEvmReceiver,
        uint256 _deadline,
        uint256 _privateKey
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        NEARIntentsPayload memory payload = _createNEARIntentsPayload(
            _currentBridgeData,
            _depositAddress,
            _deadline,
            _quoteId,
            _minAmountOut,
            _nonEvmReceiver
        );

        bytes32 domainSeparatorHash = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digestHash = _digest(domainSeparatorHash, structHash);
        bytes memory signature = _signDigest(_privateKey, digestHash);

        return
            NEARIntentsFacet.NEARIntentsData({
                nonEVMReceiver: _nonEvmReceiver,
                depositAddress: _depositAddress,
                quoteId: _quoteId,
                deadline: _deadline,
                minAmountOut: _minAmountOut,
                refundRecipient: nearIntentsRefundRecipient,
                signature: signature
            });
    }

    function _generateValidNearDataWithPrivateKey(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        uint256 _privateKey
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        uint256 deadline = block.timestamp + 1 hours;
        return
            _generateValidNearDataWithPrivateKeyAndDeadline(
                _depositAddress,
                _currentBridgeData,
                _chainId,
                _quoteId,
                _minAmountOut,
                bytes32(0),
                deadline,
                _privateKey
            );
    }

    function _generateValidNearData(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        return
            _generateValidNearDataWithPrivateKey(
                _depositAddress,
                _currentBridgeData,
                _chainId,
                _quoteId,
                _minAmountOut,
                backendSignerPrivateKey
            );
    }

    function _generateValidNearDataWithNonEVM(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        bytes32 _nonEvmReceiver
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        uint256 deadline = block.timestamp + 1 hours;
        return
            _generateValidNearDataWithPrivateKeyAndDeadline(
                _depositAddress,
                _currentBridgeData,
                _chainId,
                _quoteId,
                _minAmountOut,
                _nonEvmReceiver,
                deadline,
                backendSignerPrivateKey
            );
    }
}
