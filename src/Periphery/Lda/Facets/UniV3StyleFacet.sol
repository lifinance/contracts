// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibUniV3Logic } from "lifi/Libraries/LibUniV3Logic.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

interface IUniV3StylePool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title UniV3StyleFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles Uniswap V3 swaps with callback management
/// @custom:version 1.0.0
contract UniV3StyleFacet {
    using LibCallbackManager for *;
    using LibPackedStream for uint256;

    // ==== Constants ====
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    // ==== Errors ====
    error UniV3SwapUnexpected();

    // ==== Modifiers ====
    modifier onlyExpectedPool() {
        LibCallbackManager.verifyCallbackSender();
        _;
        LibCallbackManager.clear();
    }

    // ==== External Functions ====
    /// @notice Executes a UniswapV3 swap
    /// @param swapData The input stream containing swap parameters
    /// @param from Where to take liquidity for swap
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
        bool direction = stream.readUint8() > 0;
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
            revert UniV3SwapUnexpected();
        }
    }

    // ==== Callback Functions ====
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function xeiV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function dragonswapV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function agniSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function fusionXV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function vvsV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function supV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function zebraV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function hyperswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function laminarV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function xswapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function rabbitSwapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }

    function enosysdexV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }
}
