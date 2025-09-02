// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibCallbackAuthenticator } from "lifi/Libraries/LibCallbackAuthenticator.sol";
import { LibUniV3Logic } from "lifi/Libraries/LibUniV3Logic.sol";
import { IAlgebraPool } from "lifi/Interfaces/IAlgebraPool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { SwapCallbackNotExecuted } from "lifi/Periphery/LDA/LiFiDEXAggregatorErrors.sol";
import { PoolCallbackAuthenticator } from "lifi/Periphery/LDA/PoolCallbackAuthenticator.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title AlgebraFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles Algebra swaps with callback management
/// @custom:version 1.0.0
contract AlgebraFacet is BaseRouteConstants, PoolCallbackAuthenticator {
    using LibPackedStream for uint256;
    using SafeERC20 for IERC20;

    // ==== Constants ====
    /// @dev Minimum sqrt price ratio for Algebra pool swaps
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    /// @dev Maximum sqrt price ratio for Algebra pool swaps
    uint160 internal constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    // ==== External Functions ====
    /// @notice Executes a swap through an Algebra pool
    /// @dev Handles both regular swaps and fee-on-transfer token swaps
    /// @param swapData Encoded swap parameters [pool, direction, destinationAddress, supportsFeeOnTransfer]
    /// @param from Token source address - if equals msg.sender,
    ///         tokens will be pulled from the caller; otherwise assumes tokens are already at this contract
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapAlgebra(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1;
        address destinationAddress = stream.readAddress();
        bool supportsFeeOnTransfer = stream.readUint8() > 0;

        if (
            pool == address(0) ||
            destinationAddress == address(0) ||
            amountIn > uint256(type(int256).max)
        ) revert InvalidCallData();

        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                uint256(amountIn)
            );
        }

        LibCallbackAuthenticator.arm(pool);

        if (supportsFeeOnTransfer) {
            IAlgebraPool(pool).swapSupportingFeeOnInputTokens(
                address(this),
                destinationAddress,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        } else {
            IAlgebraPool(pool).swap(
                destinationAddress,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        }

        if (
            LibCallbackAuthenticator.callbackStorage().expected != address(0)
        ) {
            revert SwapCallbackNotExecuted();
        }
    }

    /// @notice Called by Algebra pool after executing a swap via IAlgebraPool#swap
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be verified to be an AlgebraPool using LibCallbackAuthenticator.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IAlgebraPool#swap call. Contains the input token address.
    function algebraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external onlyExpectedPool {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }
}
