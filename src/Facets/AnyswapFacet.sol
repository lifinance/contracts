// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAnyswapRouter } from "../Interfaces/IAnyswapRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { IAnyswapToken } from "../Interfaces/IAnyswapToken.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { TokenAddressIsZero, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Anyswap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
contract AnyswapFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct AnyswapData {
        address router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Anyswap
    /// @param _bridgeData the core information needed for bridging
    /// @param _anyswapData data specific to Anyswap
    function startBridgeTokensViaAnyswap(ILiFi.BridgeData memory _bridgeData, AnyswapData calldata _anyswapData)
        external
        payable
        nonReentrant
    {
        // Multichain (formerly Anyswap) tokens can wrap other tokens
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_bridgeData.sendingAssetId, _anyswapData.router);
        if (!isNative) LibAsset.depositAsset(underlyingToken, _bridgeData.minAmount);
        _startBridge(_bridgeData, _anyswapData, underlyingToken, isNative, false);
    }

    /// @notice Performs a swap before bridging via Anyswap
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _anyswapData data specific to Anyswap
    function swapAndStartBridgeTokensViaAnyswap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AnyswapData memory _anyswapData
    ) external payable nonReentrant {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) revert TokenAddressIsZero();
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_bridgeData.sendingAssetId, _anyswapData.router);
        _startBridge(_bridgeData, _anyswapData, underlyingToken, isNative, true);
    }

    /// Private Methods ///

    /// @dev Unwraps the underlying token from the Anyswap token if necessary
    /// @param token The (maybe) wrapped token
    /// @param router The Anyswap router
    function _getUnderlyingToken(address token, address router)
        private
        returns (address underlyingToken, bool isNative)
    {
        // Token must implement IAnyswapToken interface
        if (LibAsset.isNativeAsset(token)) revert TokenAddressIsZero();
        underlyingToken = IAnyswapToken(token).underlying();
        // The native token does not use the standard null address ID
        isNative = IAnyswapRouter(router).wNATIVE() == underlyingToken;
        // Some Multichain complying tokens may wrap nothing
        if (!isNative && LibAsset.isNativeAsset(underlyingToken)) {
            underlyingToken = token;
        }
    }

    /// @dev Contains the business logic for the bridge via Anyswap
    /// @param _bridgeData the core information needed for bridging
    /// @param _anyswapData data specific to Anyswap
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    /// @param hasSourceSwaps denotes whether the swap was performed before the bridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AnyswapData memory _anyswapData,
        address underlyingToken,
        bool isNative,
        bool hasSourceSwaps
    ) private {
        if (block.chainid == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        if (isNative) {
            IAnyswapRouter(_anyswapData.router).anySwapOutNative{ value: _bridgeData.minAmount }(
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.destinationChainId
            );
        } else {
            // Give Anyswap approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(underlyingToken), _anyswapData.router, _bridgeData.minAmount);
            // Was the token wrapping another token?
            if (_bridgeData.sendingAssetId != underlyingToken) {
                IAnyswapRouter(_anyswapData.router).anySwapOutUnderlying(
                    _bridgeData.sendingAssetId,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _bridgeData.destinationChainId
                );
            } else {
                IAnyswapRouter(_anyswapData.router).anySwapOut(
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
