// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IMultichainRouter } from "../Interfaces/IMultichainRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { IMultichainToken } from "../Interfaces/IMultichainToken.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { TokenAddressIsZero, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Multichain Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
contract MultichainFacet is ILiFi, ReentrancyGuard, SwapperV2 {
    /// Types ///

    struct MultichainData {
        address assetId;
        address router;
        uint256 amount;
        address receiver;
        uint256 toChainId;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Multichain
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _multichainData data specific to Multichain
    function startBridgeTokensViaMultichain(LiFiData calldata _lifiData, MultichainData calldata _multichainData)
        external
        payable
        nonReentrant
    {
        // Multichain (formerly Multichain) tokens can wrap other tokens
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_multichainData.assetId, _multichainData.router);
        if (!isNative) LibAsset.depositAsset(underlyingToken, _multichainData.amount);
        _startBridge(_lifiData, _multichainData, underlyingToken, isNative, false);
    }

    /// @notice Performs a swap before bridging via Multichain
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _multichainData data specific to Multichain
    function swapAndStartBridgeTokensViaMultichain(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        MultichainData memory _multichainData
    ) external payable nonReentrant {
        if (LibAsset.isNativeAsset(_multichainData.assetId)) revert TokenAddressIsZero();
        _multichainData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_multichainData.assetId, _multichainData.router);
        _startBridge(_lifiData, _multichainData, underlyingToken, isNative, true);
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
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _multichainData data specific to Multichain
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    /// @param hasSourceSwaps denotes whether the swap was performed before the bridge
    function _startBridge(
        LiFiData calldata _lifiData,
        MultichainData memory _multichainData,
        address underlyingToken,
        bool isNative,
        bool hasSourceSwaps
    ) private {
        if (block.chainid == _multichainData.toChainId) revert CannotBridgeToSameNetwork();

        if (isNative) {
            IMultichainRouter(_multichainData.router).anySwapOutNative{ value: _multichainData.amount }(
                _multichainData.assetId,
                _multichainData.receiver,
                _multichainData.toChainId
            );
        } else {
            // Was the token wrapping another token?
            if (_multichainData.assetId != underlyingToken) {
                LibAsset.maxApproveERC20(IERC20(underlyingToken), _multichainData.router, _multichainData.amount);
                IMultichainRouter(_multichainData.router).anySwapOutUnderlying(
                    _multichainData.assetId,
                    _multichainData.receiver,
                    _multichainData.amount,
                    _multichainData.toChainId
                );
            } else {
                // Tokens are burned which does not require allowance
                IMultichainRouter(_multichainData.router).anySwapOut(
                    _multichainData.assetId,
                    _multichainData.receiver,
                    _multichainData.amount,
                    _multichainData.toChainId
                );
            }
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "multichain",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            underlyingToken,
            _lifiData.receivingAssetId,
            _multichainData.receiver,
            _multichainData.amount,
            _multichainData.toChainId,
            hasSourceSwaps,
            false
        );
    }
}
