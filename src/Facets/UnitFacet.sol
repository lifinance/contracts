// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";

/// @title Unit Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.0
contract UnitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    // EIP-712 typehash for UnitPayload: keccak256("UnitPayload(address depositAddress,uint256 sourceChainId,uint256 destinationChainId,address sendingAssetId)");
    bytes32 private constant UNIT_PAYLOAD_TYPEHASH =
        0xa16cbca8b31407a5924d59ae6804250b7502de409873d1cb0c0fd609008b33a2;
    /// @notice The address of the backend signer that is authorized to sign the UnitPayload
    address internal immutable BACKEND_SIGNER;

    /// Types ///

    /// @notice The data that is signed by the backend
    /// @param depositAddress The address to deposit the assets to
    /// @param signature The signature of the UnitPayload signed by the backend signer using EIP-712 standard
    struct UnitData {
        address depositAddress;
        bytes signature;
    }

    /// @notice The data that is signed by the backend
    /// @param depositAddress The address to deposit the assets to
    /// @param sourceChainId The chain id of the source chain
    /// @param destinationChainId The chain id of the destination chain
    /// @param sendingAssetId The address of the sending asset
    struct UnitPayload {
        address depositAddress;
        uint256 sourceChainId;
        uint256 destinationChainId;
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
    /// @return The EIP-712 domain separator.
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
        onlyAllowDestinationChain(_bridgeData, 999)
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
        if (block.chainid == 1) {
            // deposit from ethereum mainnet to hyperliquid
            if (_bridgeData.minAmount < 0.05 ether) {
                revert InvalidAmount();
            }
        } else if (block.chainid == 9745) {
            // deposit from plasma to hyperliquid
            if (_bridgeData.minAmount < 15 ether) {
                revert InvalidAmount();
            }
        }

        if (_bridgeData.receiver != _unitData.depositAddress) {
            revert InvalidReceiver();
        }

        // --- EIP-712 signature verification ---
        // reconstruct the payload that should have been signed by the backend
        UnitPayload memory payload = UnitPayload({
            depositAddress: _unitData.depositAddress,
            sourceChainId: block.chainid,
            destinationChainId: _bridgeData.destinationChainId,
            sendingAssetId: _bridgeData.sendingAssetId
        });

        bytes32 structHash = keccak256(
            abi.encode(
                UNIT_PAYLOAD_TYPEHASH,
                payload.depositAddress,
                payload.sourceChainId,
                payload.destinationChainId,
                payload.sendingAssetId
            )
        );

        // Compute the final digest to be signed according to EIP-712: https://eips.ethereum.org/EIPS/eip-712
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        // recover the signer's address from the signature
        address recoveredSigner = ECDSA.recover(digest, _unitData.signature);

        // verify that the signer is the authorized backend
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
