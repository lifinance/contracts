// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibUniV3Logic } from "lifi/Libraries/LibUniV3Logic.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";
import { InvalidCallData, SwapCallbackNotExecuted } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title UniV3StyleFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles Uniswap V3 style swaps with callback verification
/// @custom:version 1.0.0
contract UniV3StyleFacet is BaseRouteConstants {
    using LibCallbackManager for *;
    using LibPackedStream for uint256;

    // ==== Constants ====
    /// @dev Minimum sqrt price ratio for UniV3 pool swaps
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    /// @dev Maximum sqrt price ratio for UniV3 pool swaps
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    // ==== Errors ====
    /// @dev Thrown when callback verification fails or unexpected callback state
    error UniV3SwapUnexpected();

    // ==== Modifiers ====
    /// @dev Ensures callback is from expected pool and cleans up after callback
    modifier onlyExpectedPool() {
        LibCallbackManager.verifyCallbackSender();
        _;
        LibCallbackManager.clear();
    }

    // ==== External Functions ====
    /// @notice Executes a swap through a UniV3-style pool
    /// @dev Handles token transfers and manages callback verification
    /// @param swapData Encoded swap parameters [pool, direction, recipient]
    /// @param from Token source address - if equals msg.sender, tokens will be pulled from the caller
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapUniV3(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);
        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1;
        address recipient = stream.readAddress();

        if (pool == address(0) || recipient == address(0)) {
            revert InvalidCallData();
        }

        // Transfer tokens if needed
        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        // Arm callback protection
        LibCallbackManager.arm(pool);

        // Execute swap
        IUniV3StylePool(pool).swap(
            recipient,
            direction,
            int256(amountIn),
            direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );

        // Verify callback was called (arm should be cleared by callback)
        if (LibCallbackManager.callbackStorage().expected != address(0)) {
            revert SwapCallbackNotExecuted();
        }
    }

    // ==== Callback Functions ====
    /// @notice Callback for Uniswap V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for PancakeSwap V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Ramses V2 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Xei V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function xeiV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for DragonSwap V2 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function dragonswapV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Agni swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function agniSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for FusionX V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function fusionXV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for VVS V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function vvsV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Sup V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function supV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Zebra V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function zebraV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for HyperSwap V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function hyperswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for Laminar V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function laminarV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for XSwap swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function xswapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for RabbitSwap V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function rabbitSwapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Callback for EnosysDEX V3 swaps
    /// @dev Verifies callback source and handles token transfer
    /// @param amount0Delta The amount of token0 being borrowed/repaid
    /// @param amount1Delta The amount of token1 being borrowed/repaid
    /// @param data Encoded data containing input token address
    function enosysdexV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }
}
