// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidAmount, InvalidDestinationChain } from "../Errors/GenericErrors.sol";

/// @title Unit Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.0
contract UnitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// EIP-712 ///
    // keccak256("UnitPayload(address depositAddress,uint256 sourceChainId,uint256 destinationChainId,address receiver,address sendingAssetId)");
    bytes32 private constant UNIT_PAYLOAD_TYPEHASH =
        0x7143926c49a647038e3a15f0b795e1e55913e2f574a4ea414b21b7114611453c; // TODO change
    address internal immutable BACKEND_SIGNER;

    /// Types ///
    struct UnitData {
        address depositAddress;
        bytes signature;
    }

    // EIP-712 - data that is signed by the backend
    struct UnitPayload {
        address depositAddress;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address receiver;
        address sendingAssetId;
    }

    /// Errors ///
    error InvalidSignature();

    /// Constructor ///
    constructor(address _backendSigner) {
        BACKEND_SIGNER = _backendSigner;
    }

    /// @notice Returns the EIP-712 domain separator.
    /// @dev The domain separator is calculated on the fly to ensure that `address(this)`
    /// always refers to the diamond's address when called via delegatecall.
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI Unit Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this) // This will be the diamond's address at runtime
                )
            );
    }

    /// External Methods ///

    function startBridgeTokensViaUnit(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        onlyAllowSourceToken(_bridgeData, _bridgeData.sendingAssetId)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _unitData);
    }

    function swapAndStartBridgeTokensViaUnit(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        UnitData calldata _unitData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, _bridgeData.sendingAssetId)
        onlyAllowDestinationChain(_bridgeData, 999)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _unitData);
    }

    /// Internal Methods ///
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    ) internal {
        if (_bridgeData.minAmount < 0.05 ether) {
            revert InvalidAmount();
        }

        if (
            !(_bridgeData.destinationChainId == 999 || // hyperliquid
                _bridgeData.destinationChainId == 1 || // ethereum mainnet
                _bridgeData.destinationChainId == 9745) // plume
        ) {
            revert InvalidDestinationChain();
        }

        // --- EIP-712 Signature Verification ---
        // Reconstruct the payload that should have been signed by the backend.
        UnitPayload memory payload = UnitPayload({
            depositAddress: _unitData.depositAddress,
            sourceChainId: block.chainid,
            destinationChainId: _bridgeData.destinationChainId,
            receiver: _bridgeData.receiver,
            sendingAssetId: _bridgeData.sendingAssetId
        });

        // Hash the typed data struct.
        bytes32 structHash = keccak256(
            abi.encode(
                UNIT_PAYLOAD_TYPEHASH,
                payload.depositAddress,
                payload.sourceChainId,
                payload.destinationChainId,
                payload.receiver,
                payload.sendingAssetId
            )
        );

        // Compute the final digest to be signed according to EIP-712.
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        // Recover the signer's address from the signature.
        address recoveredSigner = ECDSA.recover(digest, _unitData.signature);

        // Verify that the signer is the authorized backend.
        if (recoveredSigner != BACKEND_SIGNER) {
            revert InvalidSignature();
        }

        LibAsset.transferNativeAsset(
            payable(_unitData.depositAddress),
            _bridgeData.minAmount
        );
        emit LiFiTransferStarted(_bridgeData);
    }
}
