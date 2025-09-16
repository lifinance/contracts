// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
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
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.unit");

    struct Storage {
        bytes unitNodePublicKey;
        bytes h1NodePublicKey;
        bytes fieldNodePublicKey;
    }

    /// Types ///
    struct UnitData {
      address depositAddress;
      bytes signatures; // 192-byte blob (3x 64-byte signatures)
    }

    /// Errors ///
    error InvalidQuote();

    /// Events ///
    event UnitInitialized(bytes unitNodePublicKey, bytes h1NodePublicKey, bytes fieldNodePublicKey);

    /// Constructor ///
    constructor() {}

    /// External Methods ///
    function initUnit(bytes memory _unitNodePublicKey, bytes memory _h1NodePublicKey, bytes memory _fieldNodePublicKey) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.unitNodePublicKey = _unitNodePublicKey;
        s.h1NodePublicKey = _h1NodePublicKey;
        s.fieldNodePublicKey = _fieldNodePublicKey;
        emit UnitInitialized(_unitNodePublicKey, _h1NodePublicKey, _fieldNodePublicKey);
    }

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
        if (_bridgeData.destinationChainId != 999 || _bridgeData.destinationChainId != 1) {
            revert InvalidDestinationChain();
        }
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
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

        if (_unitData.signatures.length != 192) {
            revert InvalidQuote();
        }

        // 1. Use the simple hash, as specified in the documentation.
        bytes32 messageHash = keccak256(abi.encodePacked(_unitData.depositAddress));
        
        Storage storage s = getStorage();
        
        _verifySignature(messageHash, 0, s.unitNodePublicKey, _unitData.signatures);
        _verifySignature(messageHash, 64, s.h1NodePublicKey, _unitData.signatures);
        _verifySignature(messageHash, 128, s.fieldNodePublicKey, _unitData.signatures);

        LibAsset.transferNativeAsset(payable(_unitData.depositAddress), _bridgeData.minAmount);
        emit LiFiTransferStarted(_bridgeData);
    }

    function _verifySignature(
        bytes32 _messageHash,
        uint256 _offset,
        bytes memory _publicKey,
        bytes calldata _signatures
    ) internal pure {
        if (_publicKey.length != 65) {
            revert InvalidQuote();
        }
        
        bytes32 r;
        bytes32 s;

        assembly {
            let signaturePos := add(_signatures.offset, _offset)
            r := calldataload(signaturePos)
            s := calldataload(add(signaturePos, 0x20))
        }

        // 2. Hash the FULL 65 bytes of the public key to derive the address.
        bytes32 publicKeyHash;
        assembly {
            publicKeyHash := keccak256(add(_publicKey, 0x20), 65)
        }
        
        address expectedSigner = address(uint160(uint256(publicKeyHash)));

        if (ecrecover(_messageHash, 27, r, s) == expectedSigner) {
            return;
        }
        if (ecrecover(_messageHash, 28, r, s) == expectedSigner) {
            return;
        }

        revert InvalidQuote();
    }

    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        assembly {
            s.slot := namespace
        }
    }
}