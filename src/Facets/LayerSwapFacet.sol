// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ILayerSwapDepository } from "../Interfaces/ILayerSwapDepository.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidCallData, InvalidConfig, InvalidSignature, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title LayerSwap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through the LayerSwap Depository contract
/// @custom:version 1.0.0
contract LayerSwapFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.layerswap");

    // EIP-712 typehash: keccak256("LayerSwapPayload(bytes32 transactionId,uint256 minAmount,address receiver,bytes32 requestId,address depositoryReceiver,bytes32 nonEVMReceiver,uint256 destinationChainId,address sendingAssetId,uint256 deadline)")
    bytes32 private constant LAYERSWAP_PAYLOAD_TYPEHASH =
        0x36f801a910846003d851067e2763fa7696d5d9e7de9f98805c0ebdcaca4e87c2;

    /// Storage ///

    /// @notice Address of the LayerSwap Depository contract
    // solhint-disable-next-line immutable-vars-naming
    address public immutable LAYERSWAP_DEPOSITORY;

    /// @notice Backend signer authorized to sign LayerSwapPayload
    address internal immutable BACKEND_SIGNER;

    /// Types ///

    struct Storage {
        /// @notice Tracks used request IDs to prevent replay attacks
        mapping(bytes32 => bool) usedRequestIds;
    }

    /// @dev LayerSwap specific parameters
    /// @param requestId LayerSwap swap id (from POST /api/v2/swaps),
    ///        passed as the `id` argument to the depository
    /// @param depositoryReceiver Whitelisted address that the LayerSwap
    ///        Depository forwards the deposited funds to on the source
    ///        chain; supplied by the LI.FI backend per call. Distinct
    ///        from `bridgeData.receiver`, which is the final recipient
    ///        on the destination chain.
    /// @param nonEVMReceiver set only if bridging to non-EVM chain
    /// @param signature EIP-712 signature from the backend signer
    /// @param deadline signature expiration timestamp
    struct LayerSwapData {
        bytes32 requestId;
        address depositoryReceiver;
        bytes32 nonEVMReceiver;
        bytes signature;
        uint256 deadline;
    }

    /// Errors ///

    error SignatureExpired();
    error RequestAlreadyProcessed();

    /// Constructor ///

    /// @param _layerSwapDepository address of the LayerSwap Depository
    ///        contract on the source chain
    /// @param _backendSigner address of the backend signer
    constructor(address _layerSwapDepository, address _backendSigner) {
        if (
            _layerSwapDepository == address(0) || _backendSigner == address(0)
        ) {
            revert InvalidConfig();
        }
        LAYERSWAP_DEPOSITORY = _layerSwapDepository;
        BACKEND_SIGNER = _backendSigner;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function startBridgeTokensViaLayerSwap(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateLayerSwapData(_bridgeData, _layerSwapData);
        _verifySignature(_bridgeData, _layerSwapData);
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// @notice Performs a swap before bridging via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing
    ///        swaps before bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function swapAndStartBridgeTokensViaLayerSwap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LayerSwapData calldata _layerSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _validateLayerSwapData(_bridgeData, _layerSwapData);
        // Signature verified against pre-swap minAmount
        _verifySignature(_bridgeData, _layerSwapData);

        // NOTE: If a deposit is higher than the amount associated with the orderId due to positive slippage,
        //       then the overpaid amount will be bridged to destination chain as well.
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// Internal Methods ///

    /// @dev Validates LayerSwap-specific data
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _validateLayerSwapData(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal pure {
        if (_layerSwapData.depositoryReceiver == address(0)) {
            revert InvalidCallData();
        }
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _layerSwapData.nonEVMReceiver == bytes32(0)
        ) {
            revert InvalidNonEVMReceiver();
        }
    }

    /// @dev Contains the business logic for the bridge via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal {
        Storage storage s = getStorage();
        if (s.usedRequestIds[_layerSwapData.requestId]) {
            revert RequestAlreadyProcessed();
        }
        s.usedRequestIds[_layerSwapData.requestId] = true;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native token deposit
            ILayerSwapDepository(LAYERSWAP_DEPOSITORY).depositNative{
                value: _bridgeData.minAmount
            }(_layerSwapData.requestId, _layerSwapData.depositoryReceiver);
        } else {
            // ERC20 token deposit
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                LAYERSWAP_DEPOSITORY,
                _bridgeData.minAmount
            );

            ILayerSwapDepository(LAYERSWAP_DEPOSITORY).depositERC20(
                _layerSwapData.requestId,
                _bridgeData.sendingAssetId,
                _layerSwapData.depositoryReceiver,
                _bridgeData.minAmount
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _layerSwapData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Verifies the EIP-712 signature of the LayerSwapPayload
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _verifySignature(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal view {
        if (block.timestamp > _layerSwapData.deadline) {
            revert SignatureExpired();
        }

        bytes32 structHash = keccak256(
            abi.encode(
                LAYERSWAP_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.minAmount,
                _bridgeData.receiver,
                _layerSwapData.requestId,
                _layerSwapData.depositoryReceiver,
                _layerSwapData.nonEVMReceiver,
                _bridgeData.destinationChainId,
                _bridgeData.sendingAssetId,
                _layerSwapData.deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        address recoveredSigner = ECDSA.recover(
            digest,
            _layerSwapData.signature
        );

        if (recoveredSigner != BACKEND_SIGNER) {
            revert InvalidSignature();
        }
    }

    /// @notice Returns the EIP-712 domain separator
    /// @dev Computed on the fly so `address(this)` resolves to the
    ///      diamond's address when called via delegatecall
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI LayerSwap Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @dev Fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        assembly {
            s.slot := namespace
        }
    }
}
