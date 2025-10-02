// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidAmount, InvalidReceiver, InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title UnitFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Unit
/// @custom:version 1.0.0
contract UnitFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    // EIP-712 typehash for UnitPayload: keccak256("UnitPayload(bytes32 transactionId,uint256 minAmount,address depositAddress,uint256 destinationChainId,address sendingAssetId,uint256 deadline)");
    bytes32 private constant UNIT_PAYLOAD_TYPEHASH =
        0xc39b806ebda950382d240083ab59707cb986a2b13c2adcdd5dca5252ff247dbc;
    /// @notice The address of the backend signer that is authorized to sign the UnitPayload
    address internal immutable BACKEND_SIGNER;

    /// Types ///

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

    /// Constructor ///
    /// @notice Initializes the UnitFacet contract
    /// @param _backendSigner The address of the backend signer
    constructor(address _backendSigner) {
        BACKEND_SIGNER = _backendSigner;
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
        _validateSwapOutputIsNative(_swapData);
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

    /// @dev Validates that the final swap output is native asset
    /// @param _swapData Array of swap data
    function _validateSwapOutputIsNative(
        LibSwap.SwapData[] calldata _swapData
    ) internal pure {
        if (
            !LibAsset.isNativeAsset(
                _swapData[_swapData.length - 1].receivingAssetId
            )
        ) {
            revert InvalidCallData();
        }
    }

    /// @dev Contains the business logic for the bridge via Unit
    /// @param _bridgeData The core information needed for bridging
    /// @param _unitData Data specific to Unit
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

        // check for signature expiration
        if (block.timestamp > _unitData.deadline) {
            revert SignatureExpired();
        }

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
    ) internal {
        // compute the struct hash according to the EIP-712 standard: https://eips.ethereum.org/EIPS/eip-712
        bytes32 structHash = keccak256(
            abi.encode(
                UNIT_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId, // transactionId from payload
                _bridgeData.minAmount, // minAmount from payload
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
}
