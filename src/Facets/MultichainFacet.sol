// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IMultichainToken } from "../Interfaces/IMultichainToken.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { IMultichainRouter } from "../Interfaces/IMultichainRouter.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { TokenAddressIsZero, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Multichain Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
contract MultichainFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Types ///

    struct MultichainData {
        address router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _multichainData data specific to Multichain
    function startBridgeTokensViaMultichain(
        ILiFi.BridgeData memory _bridgeData,
        MultichainData calldata _multichainData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        // Multichain (formerly Multichain) tokens can wrap other tokens
        (address underlyingToken, bool isNative) = _getUnderlyingToken(
            _bridgeData.sendingAssetId,
            _multichainData.router
        );
        if (!isNative) LibAsset.depositAsset(underlyingToken, _bridgeData.minAmount);
        _startBridge(_bridgeData, _multichainData, underlyingToken, isNative);
    }

    /// @notice Performs a swap before bridging via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _multichainData data specific to Multichain
    function swapAndStartBridgeTokensViaMultichain(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MultichainData memory _multichainData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        (address underlyingToken, bool isNative) = _getUnderlyingToken(
            _bridgeData.sendingAssetId,
            _multichainData.router
        );
        _startBridge(_bridgeData, _multichainData, underlyingToken, isNative);
    }

    /// Private Methods ///

    /// @dev Unwraps the underlying token from the Multichain token if necessary
    /// @param token The (maybe) wrapped token
    /// @param router The Multichain router
    function _getUnderlyingToken(address token, address router)
        private
        returns (address underlyingToken, bool isNative)
    {
        // Token must implement IMultichainToken interface
        if (LibAsset.isNativeAsset(token)) revert TokenAddressIsZero();
        underlyingToken = IMultichainToken(token).underlying();
        // The native token does not use the standard null address ID
        isNative = IMultichainRouter(router).wNATIVE() == underlyingToken;
        // Some Multichain complying tokens may wrap nothing
        if (!isNative && LibAsset.isNativeAsset(underlyingToken)) {
            underlyingToken = token;
        }
    }

    /// @dev Contains the business logic for the bridge via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _multichainData data specific to Multichain
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MultichainData memory _multichainData,
        address underlyingToken,
        bool isNative
    ) private {
        if (block.chainid == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        if (isNative) {
            IMultichainRouter(_multichainData.router).anySwapOutNative{ value: _bridgeData.minAmount }(
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.destinationChainId
            );
        } else {
            // Give Multichain approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(underlyingToken), _multichainData.router, _bridgeData.minAmount);
            // Was the token wrapping another token?
            if (_bridgeData.sendingAssetId != underlyingToken) {
                IMultichainRouter(_multichainData.router).anySwapOutUnderlying(
                    _bridgeData.sendingAssetId,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _bridgeData.destinationChainId
                );
            } else {
                IMultichainRouter(_multichainData.router).anySwapOut(
                    _bridgeData.sendingAssetId,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _bridgeData.destinationChainId
                );
            }
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
