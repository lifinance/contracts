// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibUniV3Logic } from "lifi/Libraries/LibUniV3Logic.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { LibInputStream2 } from "lifi/Libraries/LibInputStream2.sol";
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
    using SafeERC20 for IERC20;
    using LibCallbackManager for *;
    using LibInputStream2 for uint256;

    /// Constants ///
    address internal constant IMPOSSIBLE_POOL_ADDRESS =
        0x0000000000000000000000000000000000000001;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    /// Errors ///
    error UniV3SwapUnexpected();

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
        uint256 stream = LibInputStream2.createStream(swapData);
        address pool = stream.readAddress();
        bool direction = stream.readUint8() > 0;
        address recipient = stream.readAddress();

        if (
            pool == address(0) ||
            pool == IMPOSSIBLE_POOL_ADDRESS ||
            recipient == address(0)
        ) {
            revert InvalidCallData();
        }

        // Transfer tokens if needed
        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
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
        LibCallbackManager.CallbackStorage storage cbStor = LibCallbackManager
            .callbackStorage();
        if (cbStor.expected != address(0)) {
            revert UniV3SwapUnexpected();
        }
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
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function xeiV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function dragonswapV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function agniSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function fusionXV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function vvsV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function supV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function zebraV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function hyperswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function laminarV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function xswapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function rabbitSwapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }

    function enosysdexV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        LibCallbackManager.verifyCallbackSender();
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
        LibCallbackManager.clear();
    }
}
