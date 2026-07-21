// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "solady/utils/ECDSA.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISymbiosisMetaRouter } from "../Interfaces/ISymbiosisMetaRouter.sol";
import { IOnchainSwapV3 } from "../Interfaces/IOnchainSwapV3.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidReceiver, InvalidDestinationChain, InvalidNonEVMReceiver, InformationMismatch, InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title Symbiosis Facet
/// @author Symbiosis (https://symbiosis.finance)
/// @notice Provides functionality for bridging through Symbiosis Protocol.
/// @notice The OnchainSwapV3 (syBTC -> Bitcoin) path forwards caller-supplied
///         `dex`/`dexgateway`/`onchainSwapData` into a trusted router. Because
///         the final Bitcoin receiver and that calldata cannot be validated
///         on-chain, this path additionally requires an EIP-712 backend
///         signature (see `_verifyOnchainSwapV3Signature`) binding those fields;
///         only backend-blessed quotes can execute.
/// @notice On the MetaRouter path the caller-supplied routing fields
///         (`callTo`/`callData` and the swap parameters) are forwarded verbatim
///         to `symbiosisMetaRouter.metaRoute`; the facet never decodes them or
///         compares them against `_bridgeData`, and `validateBridgeData` only
///         checks that `receiver`/`minAmount` are nonzero and that
///         `destinationChainId` is not the current chain. The emitted
///         `LiFiTransferStarted` `BridgeData` (receiver, destination chain) is
///         therefore descriptive, not an on-chain guarantee of where the
///         principal is delivered: integrators and wallet clear-signing surfaces
///         must not treat the displayed receiver/destination as enforced on this
///         path. This path requires no signature and matches the v1.0.0
///         MetaRouter behavior.
/// @notice This contract is not intended to custody user funds / hold balances;
///         any funds held are incidental (transient during a bridge tx) and
///         should not persist.
/// @custom:version 2.0.0
contract SymbiosisFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Constants ///

    /// @notice Namespace for this facet's diamond storage
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.symbiosis");

    // EIP-712 typehash for SymbiosisPayload: keccak256("SymbiosisPayload(bytes32 transactionId,uint256 minAmount,address sendingAssetId,uint256 destinationChainId,bytes32 nonEvmReceiver,address dex,address dexgateway,bytes32 onchainSwapDataHash,uint256 deadline,address refundRecipient)");
    bytes32 private constant SYMBIOSIS_PAYLOAD_TYPEHASH =
        0x7257da9d246759cfaab69996bef9f154218c58b1fac9dde135529906870ea848;

    /// Storage ///

    /// @notice The contract address of the Symbiosis MetaRouter on the source chain
    // solhint-disable-next-line immutable-vars-naming
    ISymbiosisMetaRouter private immutable symbiosisMetaRouter;
    // solhint-disable-next-line immutable-vars-naming
    address private immutable symbiosisGateway;
    /// @notice The Symbiosis OnchainSwapV3 router used for syBTC -> Bitcoin routes
    ///         (address(0) on chains that do not support this path)
    // solhint-disable-next-line immutable-vars-naming
    IOnchainSwapV3 private immutable onchainSwapV3;
    /// @notice The gateway the OnchainSwapV3 router pulls funds through (approve target)
    // solhint-disable-next-line immutable-vars-naming
    address private immutable onchainSwapV3Gateway;
    /// @notice The backend signer authorized to sign the OnchainSwapV3 payload
    // solhint-disable-next-line immutable-vars-naming
    address private immutable backendSigner;

    /// @notice Diamond storage for the OnchainSwapV3 path (replay protection)
    struct Storage {
        /// @dev Tracks used transaction IDs to prevent signature replay
        mapping(bytes32 => bool) usedTransactionIds;
    }

    /// Errors ///

    /// @notice Thrown when the OnchainSwapV3 path is requested on a chain where it is not configured
    error OnchainSwapV3NotSupported();
    /// @notice Thrown when the backend signature is invalid
    error InvalidSignature();
    /// @notice Thrown when the backend signature has expired
    error SignatureExpired();
    /// @notice Thrown when a transaction ID has already been processed on the OnchainSwapV3 path
    error TransactionAlreadyProcessed();

    /// Types ///

    /// @notice The data specific to Symbiosis
    /// @param refundRecipient The address that receives swap leftovers and any excess native asset; the caller (e.g. a proxy) is not assumed to be the fund owner
    /// @param nonEvmReceiver The Bitcoin receiver, emitted for non-EVM destinations
    /// @param firstSwapCalldata The calldata for the first swap
    /// @param secondSwapCalldata The calldata for the second swap
    /// @param firstDexRouter The router for the first swap
    /// @param secondDexRouter The router for the second swap
    /// @param approvedTokens The tokens approved for swapping
    /// @param callTo The bridging entrypoint
    /// @param callData The bridging calldata
    /// @param viaOnchainSwapV3 When true, route via the OnchainSwapV3 router (syBTC -> Bitcoin) instead of the MetaRouter
    /// @param dex The DEX router for the OnchainSwapV3 input-token -> syBTC swap
    /// @param dexgateway The spender the DEX is approved through for that swap
    /// @param onchainSwapData The Symbiosis-provided calldata for the OnchainSwapV3 inner swap/burn
    /// @param deadline OnchainSwapV3 only: expiry of the backend signature
    /// @param signature OnchainSwapV3 only: backend EIP-712 signature over the payload
    struct SymbiosisData {
        address refundRecipient;
        bytes32 nonEvmReceiver;
        bytes firstSwapCalldata;
        bytes secondSwapCalldata;
        address firstDexRouter;
        address secondDexRouter;
        address[] approvedTokens;
        address callTo;
        bytes callData;
        bool viaOnchainSwapV3;
        address dex;
        address dexgateway;
        bytes onchainSwapData;
        uint256 deadline;
        bytes signature;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _symbiosisMetaRouter The contract address of the Symbiosis MetaRouter on the source chain.
    /// @param _symbiosisGateway The contract address of the Symbiosis Gateway on the source chain.
    /// @param _onchainSwapV3 The Symbiosis OnchainSwapV3 router (address(0) if unsupported on this chain).
    /// @param _onchainSwapV3Gateway The gateway the OnchainSwapV3 router pulls funds through.
    /// @param _backendSigner The backend signer authorized to sign the OnchainSwapV3 payload.
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway,
        IOnchainSwapV3 _onchainSwapV3,
        address _onchainSwapV3Gateway,
        address _backendSigner
    ) {
        if (
            address(_symbiosisMetaRouter) == address(0) ||
            _symbiosisGateway == address(0) ||
            _backendSigner == address(0)
        ) revert InvalidConfig();

        // Router and its gateway must be configured together: a router with a
        // zero gateway would approve address(0) for ERC20 inputs in
        // _startBridgeViaOnchainSwapV3, silently breaking the route.
        if (
            (address(_onchainSwapV3) == address(0)) !=
            (_onchainSwapV3Gateway == address(0))
        ) revert InvalidConfig();

        // _onchainSwapV3 / _onchainSwapV3Gateway are intentionally NOT zero-checked:
        // they are address(0) on chains that do not support the syBTC -> Bitcoin path,
        // where the viaOnchainSwapV3 branch reverts (OnchainSwapV3NotSupported). This
        // lets a single facet version deploy across all chains.
        symbiosisMetaRouter = _symbiosisMetaRouter;
        symbiosisGateway = _symbiosisGateway;
        onchainSwapV3 = _onchainSwapV3;
        onchainSwapV3Gateway = _onchainSwapV3Gateway;
        backendSigner = _backendSigner;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Symbiosis
    /// @param _bridgeData The core information needed for bridging
    /// @param _symbiosisData The data specific to Symbiosis
    function startBridgeTokensViaSymbiosis(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_symbiosisData.refundRecipient))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        if (_symbiosisData.refundRecipient == address(0))
            revert InvalidCallData();

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _symbiosisData);
    }

    /// @notice Performs a swap before bridging via Symbiosis
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _symbiosisData The data specific to Symbiosis
    function swapAndStartBridgeTokensViaSymbiosis(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SymbiosisData calldata _symbiosisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_symbiosisData.refundRecipient))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        if (_symbiosisData.refundRecipient == address(0))
            revert InvalidCallData();

        // The final swap output must be the asset that gets bridged: _depositAndSwap measures
        // the received amount in the last swap's receivingAssetId, while _startBridge forwards
        // bridgeData.sendingAssetId. A mismatch would let a cheap swap output set minAmount while
        // draining a different asset the diamond holds. An empty array is left to _depositAndSwap,
        // which reverts NoSwapDataProvided.
        if (
            _swapData.length != 0 &&
            _swapData[_swapData.length - 1].receivingAssetId !=
            _bridgeData.sendingAssetId
        ) {
            revert InformationMismatch();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_symbiosisData.refundRecipient)
        );

        _startBridge(_bridgeData, _symbiosisData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Symbiosis
    /// @param _bridgeData the core information needed for bridging
    /// @param _symbiosisData data specific to Symbiosis
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    ) internal {
        if (_symbiosisData.viaOnchainSwapV3) {
            _startBridgeViaOnchainSwapV3(_bridgeData, _symbiosisData);
        } else {
            _startBridgeViaMetaRouter(_bridgeData, _symbiosisData);
        }
    }

    /// @dev Bridges via the Symbiosis MetaRouter (classic cross-chain swap through Symbiosis pools)
    /// @param _bridgeData the core information needed for bridging
    /// @param _symbiosisData data specific to Symbiosis
    function _startBridgeViaMetaRouter(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    ) private {
        // The MetaRouter pulls approvedTokens[0] from the diamond via the
        // standing gateway allowance. Pin it to the deposited sendingAssetId so a
        // caller cannot redirect the pull to another token the diamond holds a
        // residual balance of / a standing allowance for.
        if (
            _symbiosisData.approvedTokens.length == 0 ||
            _symbiosisData.approvedTokens[0] != _bridgeData.sendingAssetId
        ) revert InformationMismatch();

        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 nativeAssetAmount;

        if (isNative) {
            nativeAssetAmount = _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                symbiosisGateway,
                _bridgeData.minAmount
            );
        }

        symbiosisMetaRouter.metaRoute{ value: nativeAssetAmount }(
            ISymbiosisMetaRouter.MetaRouteTransaction(
                _symbiosisData.firstSwapCalldata,
                _symbiosisData.secondSwapCalldata,
                _symbiosisData.approvedTokens,
                _symbiosisData.firstDexRouter,
                _symbiosisData.secondDexRouter,
                _bridgeData.minAmount,
                isNative,
                _symbiosisData.callTo,
                _symbiosisData.callData
            )
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Bridges via the Symbiosis OnchainSwapV3 router (syBTC-connector chain -> Bitcoin).
    ///      The router swaps the input token to syBTC (optional) and burns it to release BTC.
    ///      A wrong `viaOnchainSwapV3` flag can only revert here, never misdirect funds:
    ///      the destination must be Bitcoin, the router must be configured, and a
    ///      non-EVM receiver must be supplied. `dex`/`dexgateway`/`onchainSwapData`
    ///      are caller-supplied and forwarded into the trusted router, so they are
    ///      additionally gated by an EIP-712 backend signature: only backend-blessed
    ///      quotes can execute, and each transaction ID is single-use (replay-proof).
    /// @param _bridgeData the core information needed for bridging
    /// @param _symbiosisData data specific to Symbiosis
    function _startBridgeViaOnchainSwapV3(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    ) private {
        if (address(onchainSwapV3) == address(0))
            revert OnchainSwapV3NotSupported();
        if (_bridgeData.receiver != NON_EVM_ADDRESS) revert InvalidReceiver();
        if (_bridgeData.destinationChainId != LIFI_CHAIN_ID_BTC)
            revert InvalidDestinationChain();
        if (_symbiosisData.nonEvmReceiver == bytes32(0))
            revert InvalidNonEVMReceiver();

        _verifyOnchainSwapV3Signature(_bridgeData, _symbiosisData);

        // Replay protection (CEI): mark this transaction ID used before the
        // external onswap call so a backend-signed quote executes at most once.
        Storage storage s = getStorage();
        if (s.usedTransactionIds[_bridgeData.transactionId])
            revert TransactionAlreadyProcessed();
        s.usedTransactionIds[_bridgeData.transactionId] = true;

        uint256 nativeAssetAmount;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            nativeAssetAmount = _bridgeData.minAmount;
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                onchainSwapV3Gateway,
                _bridgeData.minAmount
            );
        }

        onchainSwapV3.onswap{ value: nativeAssetAmount }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _symbiosisData.dex,
            _symbiosisData.dexgateway,
            _symbiosisData.onchainSwapData
        );

        emit BridgeToNonEVMChainBytes32(
            _bridgeData.transactionId,
            _bridgeData.destinationChainId,
            _symbiosisData.nonEvmReceiver
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev Verifies the EIP-712 backend signature for the OnchainSwapV3 path.
    ///      Binds the caller-supplied router calldata (`dex`/`dexgateway`/
    ///      hash of `onchainSwapData`), the Bitcoin receiver/amount, and the
    ///      `refundRecipient` so a malicious or phished quote cannot misroute
    ///      the user's in-flight funds or their refund.
    /// @param _bridgeData the core information needed for bridging
    /// @param _symbiosisData data specific to Symbiosis
    function _verifyOnchainSwapV3Signature(
        ILiFi.BridgeData memory _bridgeData,
        SymbiosisData calldata _symbiosisData
    ) private view {
        if (block.timestamp > _symbiosisData.deadline)
            revert SignatureExpired();

        bytes32 structHash = keccak256(
            abi.encode(
                SYMBIOSIS_PAYLOAD_TYPEHASH,
                _bridgeData.transactionId,
                _bridgeData.minAmount,
                _bridgeData.sendingAssetId,
                _bridgeData.destinationChainId,
                _symbiosisData.nonEvmReceiver,
                _symbiosisData.dex,
                _symbiosisData.dexgateway,
                keccak256(_symbiosisData.onchainSwapData),
                _symbiosisData.deadline,
                _symbiosisData.refundRecipient
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );

        if (ECDSA.recover(digest, _symbiosisData.signature) != backendSigner)
            revert InvalidSignature();
    }

    /// @notice Returns the EIP-712 domain separator.
    /// @dev Calculated on the fly so `address(this)` always resolves to the
    ///      diamond's address when the facet runs via delegatecall.
    /// @return The EIP-712 domain separator.
    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI Symbiosis Facet")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
