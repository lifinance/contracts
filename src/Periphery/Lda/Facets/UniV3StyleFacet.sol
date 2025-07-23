// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibUniV3Logic } from "lifi/Libraries/LibUniV3Logic.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";

/// @title UniV3 Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles Uniswap V3 swaps with callback management
/// @custom:version 1.0.0
contract UniV3StyleFacet {
    using LibCallbackManager for *;
    using LibInputStream for uint256;

    /// @notice Executes a UniswapV3 swap
    /// @param stream The input stream containing swap parameters
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapUniV3(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        return LibUniV3Logic.executeSwap(stream, from, tokenIn, amountIn);
    }

    /// @notice Callback for UniswapV3 swaps
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function xeiV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function dragonswapV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function agniSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function fusionXV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function vvsV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function supV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function zebraV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function hyperswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function laminarV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function xswapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function rabbitSwapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function enosysdexV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }
} 