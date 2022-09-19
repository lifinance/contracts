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
    /// Storage ///

    /// @notice The contract address of the router on the source chain.
    IAnyswapRouter private immutable router;

    /// Types ///

    struct AnyswapData {
        address token;
        uint256 amount;
        address recipient;
        uint256 toChainId;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the router on the source chain.
    constructor(IAnyswapRouter _router) {
        router = _router;
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
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_anyswapData.token);
        if (!isNative) LibAsset.depositAsset(underlyingToken, _anyswapData.amount);
        _startBridge(_lifiData, _anyswapData, underlyingToken, isNative, false);
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
        if (LibAsset.isNativeAsset(_anyswapData.token)) revert TokenAddressIsZero();
        _anyswapData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        (address underlyingToken, bool isNative) = _getUnderlyingToken(_anyswapData.token);
        _startBridge(_lifiData, _anyswapData, underlyingToken, isNative, true);
    }

    /// Private Methods ///

    /// @dev Unwraps the underlying token from the Anyswap token if necessary
    /// @param token The (maybe) wrapped token
    function _getUnderlyingToken(address token) private returns (address underlyingToken, bool isNative) {
        // Token must implement IAnyswapToken interface
        if (LibAsset.isNativeAsset(token)) revert TokenAddressIsZero();
        underlyingToken = IAnyswapToken(token).underlying();
        // The native token does not use the standard null address ID
        isNative = router.wNATIVE() == underlyingToken;
        // Some Multichain complying tokens may wrap nothing
        if (!isNative && LibAsset.isNativeAsset(underlyingToken)) {
            underlyingToken = token;
        }
    }

    /// @dev Contains the business logic for the bridge via Anyswap
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _anyswapData data specific to Anyswap
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    /// @param hasSourceSwaps denotes whether the swap was performed before the bridge
    function _startBridge(
        LiFiData calldata _lifiData,
        AnyswapData memory _anyswapData,
        address underlyingToken,
        bool isNative,
        bool hasSourceSwaps
    ) private {
        if (block.chainid == _anyswapData.toChainId) revert CannotBridgeToSameNetwork();

        if (isNative) {
            router.anySwapOutNative{ value: _anyswapData.amount }(
                _anyswapData.token,
                _anyswapData.recipient,
                _anyswapData.toChainId
            );
        } else {
            // Give Anyswap approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(underlyingToken), address(router), _anyswapData.amount);
            // Was the token wrapping another token?
            if (_anyswapData.token != underlyingToken) {
                router.anySwapOutUnderlying(
                    _anyswapData.token,
                    _anyswapData.recipient,
                    _anyswapData.amount,
                    _anyswapData.toChainId
                );
            } else {
                router.anySwapOut(
                    _anyswapData.token,
                    _anyswapData.recipient,
                    _anyswapData.amount,
                    _anyswapData.toChainId
                );
            }
        }

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
            hasSourceSwaps,
            false
        );
    }
}
