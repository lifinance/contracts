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
    // keccak256("NEARIntentsPayload(bytes32 transactionId,uint256 minAmount,bytes32 receiver,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline,bytes32 quoteId,uint256 minAmountOut,bytes32 destinationAsset,address refundRecipient)")
    bytes32 internal constant NEARINTENTS_PAYLOAD_TYPEHASH =
        0x4d5a33c4af83dbad79b202811c07cdb5ba5794247bde504fc57a9da2df04bb0d;

    string internal constant NEAR_DOMAIN_NAME = "LI.FI NEAR Intents Facet";
    string internal constant EIP712_VERSION = "1";

    /// @dev Set this to the diamond address (the verifyingContract used in the facet via delegatecall).
    address internal nearIntentsVerifyingContract;
    /// @dev Set this to the refund recipient bound into the signed payload.
    address internal nearIntentsRefundRecipient;
    /// @dev Set this to the destination asset word bound into the signed payload.
    bytes32 internal nearIntentsDestinationAsset;

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
        bytes32 destinationAsset;
        address refundRecipient;
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
                    _payload.minAmountOut,
                    _payload.destinationAsset,
                    _payload.refundRecipient
                )
            );
    }

    function _createNEARIntentsPayload(
        ILiFi.BridgeData memory _bridgeData,
        address _depositAddress,
        uint256 _deadline,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        bytes32 _nonEvmReceiver,
        bytes32 _destinationAsset,
        address _refundRecipient
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
                minAmountOut: _minAmountOut,
                destinationAsset: _destinationAsset,
                refundRecipient: _refundRecipient
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
            _nonEvmReceiver,
            nearIntentsDestinationAsset,
            nearIntentsRefundRecipient
        );

        bytes32 domainSeparatorHash = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digestHash = _digest(domainSeparatorHash, structHash);
        bytes memory signature = _signDigest(_privateKey, digestHash);

        return
            NEARIntentsFacet.NEARIntentsData({
                nonEVMReceiver: _nonEvmReceiver,
                destinationAsset: nearIntentsDestinationAsset,
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
