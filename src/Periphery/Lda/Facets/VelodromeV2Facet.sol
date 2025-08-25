// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title VelodromeV2Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles Velodrome V2 pool swaps
/// @custom:version 1.0.0
contract VelodromeV2Facet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== Constants ====
    /// @dev Flag to enable post-swap callback with flashloan data
    uint8 internal constant CALLBACK_ENABLED = 1;

    // ==== Errors ====
    /// @dev Thrown when pool reserves are zero, indicating an invalid pool state
    error WrongPoolReserves();

    // ==== External Functions ====
    /// @notice Performs a swap through VelodromeV2 pools
    /// @dev Handles token transfers and optional callbacks, with comprehensive safety checks
    /// @param swapData Encoded swap parameters [pool, direction, destinationAddress, callback]
    /// @param from Token source address - if equals msg.sender or this contract, tokens will be transferred;
    ///        otherwise assumes tokens are at INTERNAL_INPUT_SOURCE
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapVelodromeV2(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1;
        address destinationAddress = stream.readAddress();

        if (pool == address(0) || destinationAddress == address(0))
            revert InvalidCallData();

        bool callback = stream.readUint8() == CALLBACK_ENABLED; // if true then run callback after swap with tokenIn as flashloan data.
        // Will revert if contract (destinationAddress) does not implement IVelodromeV2PoolCallee.

        if (from == INTERNAL_INPUT_SOURCE) {
            (uint256 reserve0, uint256 reserve1, ) = IVelodromeV2Pool(pool)
                .getReserves();
            if (reserve0 == 0 || reserve1 == 0) revert WrongPoolReserves();
            uint256 reserveIn = direction ? reserve0 : reserve1;

            amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn;
        } else {
            if (from == address(this)) {
                LibAsset.transferERC20(tokenIn, pool, amountIn);
            } else if (from == msg.sender) {
                LibAsset.transferFromERC20(
                    tokenIn,
                    msg.sender,
                    pool,
                    amountIn
                );
            }
        }

        // calculate the expected output amount using the pool's getAmountOut function
        uint256 amountOut = IVelodromeV2Pool(pool).getAmountOut(
            amountIn,
            tokenIn
        );

        // set the appropriate output amount based on which token is being swapped
        // determine output amounts based on direction
        uint256 amount0Out = direction ? 0 : amountOut;
        uint256 amount1Out = direction ? amountOut : 0;

        // 'swap' function from IVelodromeV2Pool should be called from a contract which performs important safety checks.
        // Safety Checks Covered:
        // - Reentrancy: LDA has a custom lock() modifier
        // - Token transfer safety: SafeERC20 is used to ensure token transfers revert on failure
        // - Expected output verification: The contract calls getAmountOut (including fees) before executing the swap
        // - Flashloan trigger: A flashloan flag is used to determine if the callback should be triggered
        // - Post-swap verification: In processRouteInternal, it verifies that the destinationAddress receives at least minAmountOut
        //      and that the sender's final balance is not less than the initial balance
        // - Immutable interaction: Velodrome V2 pools and the router are not upgradable,
        //      so we can rely on the behavior of getAmountOut and swap

        // ATTENTION FOR CALLBACKS / HOOKS:
        // - destinationAddress contracts should validate that msg.sender is the Velodrome pool contract who is calling the hook
        // - destinationAddress contracts must not manipulate their own tokenOut balance
        //   (as this may bypass/invalidate the built-in slippage protection)
        // - @developers: never trust balance-based slippage protection for callback of destinationAddress
        // - @integrators: do not use slippage guarantees when destinationAddress is a contract with side-effects
        IVelodromeV2Pool(pool).swap(
            amount0Out,
            amount1Out,
            destinationAddress,
            callback ? abi.encode(tokenIn) : bytes("")
        );
    }
}
