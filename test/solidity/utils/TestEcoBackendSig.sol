// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { TestEIP712 } from "./TestEIP712.sol";

/// @title TestEcoBackendSig
/// @notice Payload-specific backend EIP-712 signature helpers for `EcoFacet` tests.
abstract contract TestEcoBackendSig is TestEIP712 {
    // EIP-712 typehash for EcoPayload:
    // keccak256("EcoPayload(bytes32 transactionId,address sendingAssetId,uint256 minAmount,uint256 destinationChainId,address receiver,bytes32 nonEVMReceiverHash,uint64 intentDestination,bytes32 encodedRouteHash,address prover,address refundRecipient,uint64 rewardDeadline,bytes32 solanaATA,uint256 deadline)")
    bytes32 internal constant ECO_PAYLOAD_TYPEHASH =
        0x5eab41fdaef699ef7c6516a09842972b29e6319a531c00a7f90ab2292d78d9d8;

    string internal constant ECO_DOMAIN_NAME = "LI.FI Eco Facet";
    string internal constant ECO_EIP712_VERSION = "1";

    /// @dev Diamond address (the verifyingContract used by the facet via delegatecall).
    address internal ecoVerifyingContract;

    /// @dev Backend signer private key and derived address (configured in `setUp()`).
    uint256 internal backendSignerPrivateKey;
    address internal backendSignerAddress;

    function _buildEcoStructHash(
        ILiFi.BridgeData memory _bridgeData,
        EcoFacet.EcoData memory _ecoData
    ) internal pure returns (bytes32) {
        return
            keccak256(
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
    }

    /// @dev Signs the EcoPayload derived from the given bridge and eco data with
    ///      the configured backend signer key. Reads `_ecoData.deadline`, so set
    ///      it before calling.
    function _signEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoFacet.EcoData memory _ecoData
    ) internal view returns (bytes memory) {
        return
            _signEcoDataWith(backendSignerPrivateKey, _bridgeData, _ecoData);
    }

    /// @dev Same as `_signEcoData` but signs with an arbitrary key (used to test
    ///      signatures from an unauthorized signer).
    function _signEcoDataWith(
        uint256 _privateKey,
        ILiFi.BridgeData memory _bridgeData,
        EcoFacet.EcoData memory _ecoData
    ) internal view returns (bytes memory) {
        bytes32 domainSeparatorHash = _domainSeparator(
            ECO_DOMAIN_NAME,
            ECO_EIP712_VERSION,
            block.chainid,
            ecoVerifyingContract
        );
        bytes32 structHash = _buildEcoStructHash(_bridgeData, _ecoData);
        bytes32 digestHash = _digest(domainSeparatorHash, structHash);
        return _signDigest(_privateKey, digestHash);
    }
}
