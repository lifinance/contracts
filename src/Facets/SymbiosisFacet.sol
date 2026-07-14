// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISymbiosisMetaRouter } from "../Interfaces/ISymbiosisMetaRouter.sol";
import { IOnchainSwapV3 } from "../Interfaces/IOnchainSwapV3.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidReceiver, InvalidDestinationChain, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

/// @title Symbiosis Facet
/// @author Symbiosis (https://symbiosis.finance)
/// @notice Provides functionality for bridging through Symbiosis Protocol
/// @custom:version 2.0.0
contract SymbiosisFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
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

    /// Errors ///

    /// @notice Thrown when the OnchainSwapV3 path is requested on a chain where it is not configured
    error OnchainSwapV3NotSupported();

    /// Types ///

    /// @notice The data specific to Symbiosis
    /// @param nonEvmReceiver The Bitcoin receiver, emitted for non-EVM destinations
    /// @param firstSwapCalldata The calldata for the first swap
    /// @param secondSwapCalldata The calldata for the second swap
    /// @param intermediateToken The intermediate token used for swapping
    /// @param firstDexRouter The router for the first swap
    /// @param secondDexRouter The router for the second swap
    /// @param approvedTokens The tokens approved for swapping
    /// @param callTo The bridging entrypoint
    /// @param callData The bridging calldata
    /// @param viaOnchainSwapV3 When true, route via the OnchainSwapV3 router (syBTC -> Bitcoin) instead of the MetaRouter
    /// @param dex The DEX router for the OnchainSwapV3 input-token -> syBTC swap
    /// @param dexgateway The spender the DEX is approved through for that swap
    /// @param onchainSwapData The Symbiosis-provided calldata for the OnchainSwapV3 inner swap/burn
    struct SymbiosisData {
        bytes32 nonEvmReceiver;
        bytes firstSwapCalldata;
        bytes secondSwapCalldata;
        address intermediateToken;
        address firstDexRouter;
        address secondDexRouter;
        address[] approvedTokens;
        address callTo;
        bytes callData;
        bool viaOnchainSwapV3;
        address dex;
        address dexgateway;
        bytes onchainSwapData;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _symbiosisMetaRouter The contract address of the Symbiosis MetaRouter on the source chain.
    /// @param _symbiosisGateway The contract address of the Symbiosis Gateway on the source chain.
    /// @param _onchainSwapV3 The Symbiosis OnchainSwapV3 router (address(0) if unsupported on this chain).
    /// @param _onchainSwapV3Gateway The gateway the OnchainSwapV3 router pulls funds through.
    constructor(
        ISymbiosisMetaRouter _symbiosisMetaRouter,
        address _symbiosisGateway,
        IOnchainSwapV3 _onchainSwapV3,
        address _onchainSwapV3Gateway
    ) {
        if (
            address(_symbiosisMetaRouter) == address(0) ||
            _symbiosisGateway == address(0)
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
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
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
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
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
    ///      non-EVM receiver must be supplied.
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
}
