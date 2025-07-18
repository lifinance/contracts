// SPDX-License-Identifier: LGPL-3.0-only
/// @custom:version 1.0.0
pragma solidity ^0.8.17;

import { LibInputStream } from "./LibInputStream.sol";
import { LibCallbackManager } from "./LibCallbackManager.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";

interface IUniV3StylePool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title UniV3 Logic Library
/// @author LI.FI (https://li.fi)
/// @notice Shared logic for UniV3-style DEX protocols
library LibUniV3Logic {
    using SafeERC20 for IERC20;
    using LibInputStream for uint256;

    /// Constants ///
    address internal constant IMPOSSIBLE_POOL_ADDRESS = 0x0000000000000000000000000000000000000001;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// Errors ///
    error UniV3SwapUnexpected();

    /// @notice Executes a generic UniV3-style swap
    /// @param stream The input stream containing swap parameters
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function executeSwap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
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
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
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
        LibCallbackManager.CallbackStorage storage cbStor = LibCallbackManager.callbackStorage();
        if (cbStor.expected != address(0)) {
            revert UniV3SwapUnexpected();
        }
    }

    /// @notice Handles a generic UniV3-style callback
    /// @param amount0Delta The amount of token0 owed to pool
    /// @param amount1Delta The amount of token1 owed to pool
    /// @param data The callback data containing tokenIn address
    function handleCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) internal {
        int256 amount = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (amount <= 0) {
            return; // Nothing to pay
        }

        address tokenIn = abi.decode(data, (address));
        IERC20(tokenIn).safeTransfer(msg.sender, uint256(amount));
    }
} 