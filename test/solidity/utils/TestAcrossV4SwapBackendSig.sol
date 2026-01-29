// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { TestEIP712 } from "./TestEIP712.sol";

/// @title TestAcrossV4SwapBackendSig
/// @notice Payload-specific signature helpers for `AcrossV4SwapFacet` Swap API tests.
abstract contract TestAcrossV4SwapBackendSig is TestEIP712 {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    // EIP-712 typehash for AcrossV4SwapPayload:
    // keccak256("AcrossV4SwapPayload(bytes32 transactionId,uint256 minAmount,address receiver,uint256 destinationChainId,address sendingAssetId,uint8 swapApiTarget,bytes32 callDataHash)");
    bytes32 private constant ACROSS_V4_SWAP_PAYLOAD_TYPEHASH =
        0xb62acc761ee932340747d9b4a076ede3e00bcbc7b32d4d6c1ab72546e5e5b154;

    /// @dev Backend signer private key (tests typically configure in `setUp()` and derive `backendSigner`).
    uint256 internal backendSignerPk;
    address internal backendSigner;

    function _domainSeparator(
        address _verifyingContract
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes("LI.FI Across V4 Swap Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    _verifyingContract
                )
            );
    }

    function _acrossV4SwapDigest(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapFacet.SwapApiTarget _swapApiTarget,
        bytes memory _callData,
        address _verifyingContract
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ACROSS_V4_SWAP_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.minAmount,
                _bridgeData.receiver,
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                uint8(_swapApiTarget),
                keccak256(_callData)
            )
        );

        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _domainSeparator(_verifyingContract),
                    structHash
                )
            );
    }

    function _signAcrossV4Swap(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapFacet.SwapApiTarget _swapApiTarget,
        bytes memory _callData,
        address _verifyingContract
    ) internal returns (bytes memory) {
        bytes32 digestHash = _acrossV4SwapDigest(
            _bridgeData,
            _swapApiTarget,
            _callData,
            _verifyingContract
        );

        return _signDigest(backendSignerPk, digestHash);
    }

    function _facetData(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapFacet.SwapApiTarget _swapApiTarget,
        bytes memory _callData,
        address _verifyingContract
    ) internal returns (AcrossV4SwapFacet.AcrossV4SwapFacetData memory) {
        bytes memory signature = "";
        if (
            _swapApiTarget == AcrossV4SwapFacet.SwapApiTarget.SpokePool ||
            _swapApiTarget ==
            AcrossV4SwapFacet.SwapApiTarget.SpokePoolPeriphery
        ) {
            signature = _signAcrossV4Swap(
                _bridgeData,
                _swapApiTarget,
                _callData,
                _verifyingContract
            );
        }

        return
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: _swapApiTarget,
                callData: _callData,
                signature: signature
            });
    }
}
