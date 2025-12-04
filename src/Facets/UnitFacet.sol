// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title UnitFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.1
contract UnitFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.unit");

    // EIP-712 typehash for UnitPayload: keccak256("UnitPayload(bytes32 transactionId,uint256 minAmount,address receiver,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline)");
    bytes32 private constant UNIT_PAYLOAD_TYPEHASH =
        0xe40c93b75fa097357b7b866c9d28e3dba6e987fba2808befeaafebac93b94cba;

    /// @notice The address of the backend signer that is authorized to sign the UnitPayload
    address internal immutable BACKEND_SIGNER;

    /// Types ///

    struct Storage {
        /// @notice Tracks used transaction IDs to prevent replay attacks
        mapping(bytes32 => bool) usedTransactionIds;
    }

    /// @notice The data that is signed by the backend
    /// @param depositAddress The address to deposit the assets to
    /// @param signature The signature of the UnitPayload signed by the backend signer using EIP-712 standard
    /// @param deadline The deadline for the signature
    struct UnitData {
        address depositAddress;
        bytes signature;
        uint256 deadline;
    }

    /// Errors ///
    /// @notice Thrown when the signature is invalid
    error InvalidSignature();
    /// @notice Thrown when the signature is expired
    error SignatureExpired();
    /// @notice Thrown when the chain is unsupported
    error UnsupportedChain();
    /// @notice Thrown when a transaction with the same ID has already been processed
    error TransactionAlreadyProcessed();

    /// Constructor ///
    /// @notice Initializes the UnitFacet contract
    /// @param _backendSigner The address of the backend signer
    constructor(address _backendSigner) {
        if (_backendSigner == address(0)) {
            revert InvalidConfig();
        }
        BACKEND_SIGNER = _backendSigner;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Unit
    /// @dev IMPORTANT: Unit protocol enforces minimum deposit amounts to ensure deposits are sufficiently
    /// above network fees. Amounts below the minimum threshold may result in irrecoverable fund loss.
    /// These minimums are validated by the backend in the signed payload, but integrators should
    /// ensure amounts meet these requirements before calling this function.
    /// For the most up-to-date minimum amounts, refer to:
    /// https://docs.hyperunit.xyz/developers/api/generate-address and https://app.hyperunit.xyz/
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
        onlyAllowSourceToken(_bridgeData, LibAsset.NULL_ADDRESS) // only allow native asset
        onlyAllowDestinationChain(_bridgeData, LIFI_CHAIN_ID_HYPERCORE)
    {
        _verifySignature(_bridgeData, _unitData);
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _unitData);
    }

    /// @notice Performs a swap before bridging via Unit
    /// @dev IMPORTANT: Unit protocol enforces minimum deposit amounts to ensure deposits are sufficiently
    /// above network fees. Amounts below the minimum threshold may result in irrecoverable fund loss.
    /// These minimums are validated by the backend in the signed payload, but integrators should
    /// ensure amounts meet these requirements before calling this function.
    /// For the most up-to-date minimum amounts, refer to:
    /// https://docs.hyperunit.xyz/developers/api/generate-address and https://app.hyperunit.xyz/
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
        onlyAllowSourceToken(_bridgeData, LibAsset.NULL_ADDRESS) // only allow native asset
        onlyAllowDestinationChain(_bridgeData, LIFI_CHAIN_ID_HYPERCORE)
    {
        // The signature is intentionally verified with the pre-swap `minAmount`
        _verifySignature(_bridgeData, _unitData);
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
        Storage storage s = getStorage();
        if (s.usedTransactionIds[_bridgeData.transactionId]) {
            revert TransactionAlreadyProcessed();
        }
        s.usedTransactionIds[_bridgeData.transactionId] = true;

        // Note: We intentionally do not add an explicit zero address validation for
        // `_unitData.depositAddress` here. The subsequent call to
        // `LibAsset.transferNativeAsset(payable(_unitData.depositAddress), _bridgeData.minAmount)`
        // will revert if `depositAddress` is address(0), ensuring user funds are never lost.
        // Adding a redundant check would only increase gas usage without improving safety.

        LibAsset.transferNativeAsset(
            payable(_unitData.depositAddress),
            _bridgeData.minAmount
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Verifies the signature of the UnitPayload
    /// @param _bridgeData The core information needed for bridging
    /// @param _unitData Data specific to Unit
    function _verifySignature(
        ILiFi.BridgeData memory _bridgeData,
        UnitData calldata _unitData
    ) internal view {
        // check for signature expiration
        if (block.timestamp > _unitData.deadline) {
            revert SignatureExpired();
        }

        // compute the struct hash according to the EIP-712 standard: https://eips.ethereum.org/EIPS/eip-712
        bytes32 structHash = keccak256(
            abi.encode(
                UNIT_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId, // transactionId from payload
                _bridgeData.minAmount, // minAmount from payload
                _bridgeData.receiver, // receiver from payload
                _unitData.depositAddress, // depositAddress from payload
                _bridgeData.destinationChainId, // destinationChainId from payload
                _bridgeData.sendingAssetId, // sendingAssetId from payload
                _unitData.deadline // deadline from payload
            )
        );

        // compute the final digest to be signed according to EIP-712
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        // recover the signer's address from the signature
        address recoveredSigner = ECDSA.recover(digest, _unitData.signature);

        // verify that the signer is the authorized backend
        if (recoveredSigner != BACKEND_SIGNER) {
            revert InvalidSignature();
        }
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

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        assembly {
            s.slot := namespace
        }
    }
}
