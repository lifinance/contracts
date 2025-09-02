// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibCallbackAuthenticator } from "lifi/Libraries/LibCallbackAuthenticator.sol";
import { IiZiSwapPool } from "lifi/Interfaces/IiZiSwapPool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { SwapCallbackNotExecuted } from "lifi/Periphery/LDA/LiFiDEXAggregatorErrors.sol";
import { PoolCallbackAuthenticator } from "lifi/Periphery/LDA/PoolCallbackAuthenticator.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title IzumiV3Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles IzumiV3 swaps with callback management
/// @custom:version 1.0.0
contract IzumiV3Facet is BaseRouteConstants, PoolCallbackAuthenticator {
    using LibPackedStream for uint256;
    using LibCallbackAuthenticator for *;

    // ==== Constants ====
    /// @dev Minimum point boundary for iZiSwap pool price range
    int24 internal constant IZUMI_LEFT_MOST_PT = -800000;
    /// @dev Maximum point boundary for iZiSwap pool price range
    int24 internal constant IZUMI_RIGHT_MOST_PT = 800000;

    // ==== Errors ====
    /// @dev Thrown when callback amount to pay is zero
    error IzumiV3SwapCallbackNotPositiveAmount();

    // ==== External Functions ====
    /// @notice Executes a swap through an iZiSwap V3 pool
    /// @dev Handles both X to Y and Y to X swaps with callback verification
    /// @param swapData Encoded swap parameters [pool, direction, destinationAddress]
    /// @param from Token source address - if equals msg.sender, tokens will be pulled from the caller
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapIzumiV3(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1; // 0 = Y2X, 1 = X2Y
        address destinationAddress = stream.readAddress();

        if (
            pool == address(0) ||
            destinationAddress == address(0) ||
            amountIn > type(uint128).max
        ) revert InvalidCallData();

        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        LibCallbackAuthenticator.arm(pool);

        if (direction) {
            IiZiSwapPool(pool).swapX2Y(
                destinationAddress,
                uint128(amountIn),
                IZUMI_LEFT_MOST_PT + 1,
                abi.encode(tokenIn)
            );
        } else {
            IiZiSwapPool(pool).swapY2X(
                destinationAddress,
                uint128(amountIn),
                IZUMI_RIGHT_MOST_PT - 1,
                abi.encode(tokenIn)
            );
        }

        // After the swapX2Y or swapY2X call, the callback should clear the registered pool
        // If it hasn't, it means the callback either didn't happen, was incorrect, or the pool misbehaved
        // so we revert to protect against misuse or faulty integrations
        if (
            LibCallbackAuthenticator.callbackStorage().expected != address(0)
        ) {
            revert SwapCallbackNotExecuted();
        }
    }

    // ==== Callback Functions ====
    /// @notice Callback for X to Y swaps from iZiSwap pool
    /// @dev Verifies callback source and handles token transfer
    /// @param amountX Amount of token0 that must be sent to the pool
    /// @param data Encoded data containing input token address
    function swapX2YCallback(
        uint256 amountX,
        uint256,
        bytes calldata data
    ) external onlyExpectedPool {
        _handleIzumiV3SwapCallback(amountX, data);
    }

    /// @notice Callback for Y to X swaps from iZiSwap pool
    /// @dev Verifies callback source and handles token transfer
    /// @param amountY Amount of token1 that must be sent to the pool
    /// @param data Encoded data containing input token address
    function swapY2XCallback(
        uint256,
        uint256 amountY,
        bytes calldata data
    ) external onlyExpectedPool {
        _handleIzumiV3SwapCallback(amountY, data);
    }

    // ==== Private Functions ====
    /// @dev Common logic for iZiSwap callbacks
    /// @param amountToPay The amount of tokens to be sent to the pool
    /// @param data The data passed through by the caller
    function _handleIzumiV3SwapCallback(
        uint256 amountToPay,
        bytes calldata data
    ) private {
        if (amountToPay == 0) {
            revert IzumiV3SwapCallbackNotPositiveAmount();
        }

        address tokenIn = abi.decode(data, (address));
        LibAsset.transferERC20(tokenIn, msg.sender, amountToPay);
    }
}
