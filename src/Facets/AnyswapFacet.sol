// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAnyswapRouter } from "../Interfaces/IAnyswapRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { IAnyswapToken } from "../Interfaces/IAnyswapToken.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { TokenAddressIsZero, InvalidAmount, CannotBridgeToSameNetwork, NativeValueWithERC } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/// @title Anyswap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
contract AnyswapFacet is ILiFi, Swapper, ReentrancyGuard {
    /// Types ///

    struct AnyswapData {
        address token;
        address router;
        uint256 amount;
        address recipient;
        uint256 toChainId;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Anyswap
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _anyswapData data specific to Anyswap
    function startBridgeTokensViaAnyswap(LiFiData calldata _lifiData, AnyswapData calldata _anyswapData)
        external
        payable
        nonReentrant
    {
        // Multichain (formerly Anyswap) tokens can wrap other tokens
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_anyswapData.token, _anyswapData.router);
        if (!isNative) LibAsset.depositAsset(underlyingToken, _anyswapData.amount);
        _startBridge(_anyswapData, underlyingToken, isNative);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "anyswap",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            underlyingToken,
            _lifiData.receivingAssetId,
            _anyswapData.recipient,
            _anyswapData.amount,
            _anyswapData.toChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via Anyswap
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _anyswapData data specific to Anyswap
    function swapAndStartBridgeTokensViaAnyswap(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        AnyswapData memory _anyswapData
    ) external payable nonReentrant {
        if (_anyswapData.token == address(0)) revert TokenAddressIsZero();
        _anyswapData.amount = _executeAndCheckSwaps(_lifiData, _swapData);
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_anyswapData.token, _anyswapData.router);
        _startBridge(_anyswapData, underlyingToken, isNative);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "anyswap",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _anyswapData.recipient,
            _swapData[0].fromAmount,
            _anyswapData.toChainId,
            true,
            false
        );
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
        if (token == address(0)) revert TokenAddressIsZero();
        underlyingToken = IAnyswapToken(token).underlying();
        // The native token does not use the standard null address ID
        isNative = IAnyswapRouter(router).wNATIVE() == underlyingToken;
        // Some Multichain complying tokens may wrap nothing
        if (!isNative && underlyingToken == address(0)) {
            underlyingToken = token;
        }
    }

    /// @dev Conatains the business logic for the bridge via Anyswap
    /// @param _anyswapData data specific to Anyswap
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    function _startBridge(
        AnyswapData memory _anyswapData,
        address underlyingToken,
        bool isNative
    ) private {
        if (block.chainid == _anyswapData.toChainId) revert CannotBridgeToSameNetwork();

        if (isNative) {
            IAnyswapRouter(_anyswapData.router).anySwapOutNative{ value: _anyswapData.amount }(
                _anyswapData.token,
                _anyswapData.recipient,
                _anyswapData.toChainId
            );
        } else {
            // Give Anyswap approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(underlyingToken), _anyswapData.router, _anyswapData.amount);
            // Was the token wrapping another token?
            if (_anyswapData.token != underlyingToken) {
                IAnyswapRouter(_anyswapData.router).anySwapOutUnderlying(
                    _anyswapData.token,
                    _anyswapData.recipient,
                    _anyswapData.amount,
                    _anyswapData.toChainId
                );
            } else {
                IAnyswapRouter(_anyswapData.router).anySwapOut(
                    _anyswapData.token,
                    _anyswapData.recipient,
                    _anyswapData.amount,
                    _anyswapData.toChainId
                );
            }
        }
    }
}
