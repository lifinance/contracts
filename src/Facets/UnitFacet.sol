// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import { console } from "forge-std/console.sol";

/// @title Unit Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.0
contract UnitFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    // todo change to immutable or storage
    bytes internal  UNIT_NODE_PUBLIC_KEY;
    bytes internal  H1_NODE_PUBLIC_KEY;
    bytes internal  FIELD_NODE_PUBLIC_KEY;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param depositAddress Deposit address
    struct UnitData {
      address depositAddress; //hyperliquid deposit address
      bytes signatures; // 195-byte signature blob
    }

    /// Errors ///

    error InvalidQuote();

    /// Constructor ///

    /// @notice Constructor for the contract.
    ///         Should only be used to set immutable variables.
    ///         Anything that cannot be set as immutable should be set
    ///         in an init() function called during a diamondCut().
    /// @param _unitNodePublicKey The public key of the unit node.
    /// @param _h1NodePublicKey The public key of the h1 node.
    /// @param _fieldNodePublicKey The public key of the field node.
    constructor(bytes memory _unitNodePublicKey, bytes memory _h1NodePublicKey, bytes memory _fieldNodePublicKey) {
        UNIT_NODE_PUBLIC_KEY = _unitNodePublicKey;
        H1_NODE_PUBLIC_KEY = _h1NodePublicKey;
        FIELD_NODE_PUBLIC_KEY = _fieldNodePublicKey;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Unit
    /// @param _bridgeData The core information needed for bridging
    /// @param _unitData Data specific to Unit
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
        onlyAllowDestinationChain(_bridgeData, 999) // hyperevm only
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _unitData);
    }

    /// @notice Performs a swap before bridging via Unit
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _unitData Data specific to Unit
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
        onlyAllowDestinationChain(_bridgeData, 999) // hyperevm only
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

    /// @dev Contains the business logic for the bridge via Unit
    /// @param _bridgeData The core information needed for bridging
    /// @param _unitData Data specific to Unit
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    ) internal {
        // the minimum ETH amount is 0.05 ETH (5e16 wei) mentioned in https://docs.hyperunit.xyz/developers/api/generate-address
        console.log("minAmount");
        console.log(_bridgeData.minAmount);
        if (_bridgeData.minAmount < 0.05 ether) {
            revert InvalidAmount();
        }

        // --- Guardian Signature Verification ---

        // 1. Check if the concatenated signature is the correct length (3 guardians * 65 bytes/signature).
        if (_unitData.signatures.length != 195) {
            revert InvalidQuote();
        }

        // 2. Prepare the message hash that was signed by the guardians.
        // The signed message is the keccak256 hash of the deposit address.
        bytes32 messageHash = keccak256(abi.encodePacked(_unitData.depositAddress));

        // 3. Verify the signature from each of the three guardians.
        _verifySignature(messageHash, 0, UNIT_NODE_PUBLIC_KEY, _unitData.signatures);
        _verifySignature(messageHash, 65, H1_NODE_PUBLIC_KEY, _unitData.signatures);
        _verifySignature(messageHash, 130, FIELD_NODE_PUBLIC_KEY, _unitData.signatures);


        // send funds to the deposit address
       LibAsset.transferNativeAsset(payable(_unitData.depositAddress), _bridgeData.minAmount);

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Verifies a single ECDSA signature against a public key.
    /// @param _messageHash The hash of the message that was signed.
    /// @param _offset The starting position of the signature in the concatenated bytes array.
    /// @param _publicKey The 64-byte public key of the expected signer.
    /// @param _signatures The concatenated 195-byte signature blob.
    function _verifySignature(
        bytes32 _messageHash,
        uint256 _offset,
        bytes memory _publicKey,
        bytes calldata _signatures
    ) internal pure {
        bytes32 r;
        bytes32 s;
        uint8 v;

        // Extract r, s, and v from the signature blob using assembly for gas efficiency.
        assembly {
            let signaturePos := add(_signatures.offset, _offset)
            r := calldataload(signaturePos)
            s := calldataload(add(signaturePos, 0x20)) // 32 bytes after r
            v := byte(0, calldataload(add(signaturePos, 0x40))) // 64 bytes after r
        }

        // Derive the expected signer's address from their public key.
        // The address is the last 20 bytes of the keccak256 hash of the public key.
        address expectedSigner = address(uint160(uint256(keccak256(abi.encodePacked(_publicKey)))));

        // Recover the signer's address from the signature and message hash.
        address recoveredSigner = ecrecover(_messageHash, v, r, s);

        // Revert if the recovered address is the zero address (invalid signature)
        // or if it does not match the expected signer's address.
        if (recoveredSigner == address(0) || recoveredSigner != expectedSigner) {
            revert InvalidQuote();
        }
    }
}
