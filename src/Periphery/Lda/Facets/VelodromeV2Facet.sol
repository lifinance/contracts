// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibInputStream2 } from "lifi/Libraries/LibInputStream2.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title VelodromeV2 Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles VelodromeV2 swaps with callback management
/// @custom:version 1.0.0
contract VelodromeV2Facet {
    using LibInputStream2 for uint256;
    using SafeERC20 for IERC20;

    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;
    uint8 internal constant CALLBACK_ENABLED = 1;
    address internal constant INTERNAL_INPUT_SOURCE = address(0);

    error WrongPoolReserves();

    /// @notice Performs a swap through VelodromeV2 pools
    /// @dev This function does not handle native token swaps directly, so processNative command cannot be used
    /// @param swapData ALL remaining data from the route (starts with selector)
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    /// @return bytesRead Number of bytes consumed from swapData
    function swapVelodromeV2(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        // Track bytes read
        uint256 initialPos;
        uint256 stream = LibInputStream2.createStream(swapData);
        assembly {
            initialPos := mload(stream)
        }

        // Read parameters
        stream.readBytes4(); // Skip selector
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8();
        address to = stream.readAddress();
        bool callback = stream.readUint8() == CALLBACK_ENABLED;
        
        if (pool == address(0) || to == address(0)) revert InvalidCallData();

        // Handle input source and transfer - GET THE CORRECTED AMOUNT
        uint256 actualAmountIn = _handleInputAndTransfer(from, tokenIn, amountIn, pool, direction);


        // Calculate and execute swap with corrected amount
        _executeSwap(pool, tokenIn, actualAmountIn, to, direction, callback);

        // Return bytes read
        uint256 finalPos;
        assembly {
            finalPos := mload(stream)
        }
        return finalPos - initialPos;
    }

    /// @dev Handles input source validation and token transfer
    /// @return actualAmountIn The actual amount to use for the swap
    function _handleInputAndTransfer(
        address from,
        address tokenIn,
        uint256 amountIn,
        address pool,
        uint8 direction
    ) private returns (uint256 actualAmountIn) {
        if (from == INTERNAL_INPUT_SOURCE) {
            (uint256 reserve0, uint256 reserve1, ) = IVelodromeV2Pool(pool)
                .getReserves();
            if (reserve0 == 0 || reserve1 == 0) revert WrongPoolReserves();
            
            // Calculate the actual amount based on pool balance vs reserves
            actualAmountIn = IERC20(tokenIn).balanceOf(pool) - 
                (direction == DIRECTION_TOKEN0_TO_TOKEN1 ? reserve0 : reserve1);
        } else {
            // Use the provided amount and handle transfer
            actualAmountIn = amountIn;
            if (from == address(this)) {
                IERC20(tokenIn).safeTransfer(pool, amountIn);
            } else if (from == msg.sender) {
                IERC20(tokenIn).safeTransferFrom(msg.sender, pool, amountIn);
            }
        }
    }

    /// @dev Executes the swap on Velodrome pool
    function _executeSwap(
        address pool,
        address tokenIn,
        uint256 amountIn,
        address to,
        uint8 direction,
        bool callback
    ) private {
        uint256 amountOut = IVelodromeV2Pool(pool).getAmountOut(
            amountIn,
            tokenIn
        );

        // set the appropriate output amount based on which token is being swapped
        // determine output amounts based on direction
        uint256 amount0Out = direction == DIRECTION_TOKEN0_TO_TOKEN1
            ? 0
            : amountOut;
        uint256 amount1Out = direction == DIRECTION_TOKEN0_TO_TOKEN1
            ? amountOut
            : 0;

        // 'swap' function from IVelodromeV2Pool should be called from a contract which performs important safety checks.
        // Safety Checks Covered:
        // - Reentrancy: LDA has a custom lock() modifier
        // - Token transfer safety: SafeERC20 is used to ensure token transfers revert on failure
        // - Expected output verification: The contract calls getAmountOut (including fees) before executing the swap
        // - Flashloan trigger: A flashloan flag is used to determine if the callback should be triggered
        // - Post-swap verification: In processRouteInternal, it verifies that the recipient receives at least minAmountOut
        //      and that the sender's final balance is not less than the initial balance
        // - Immutable interaction: Velodrome V2 pools and the router are not upgradable,
        //      so we can rely on the behavior of getAmountOut and swap

        // ATTENTION FOR CALLBACKS / HOOKS:
        // - recipient contracts should validate that msg.sender is the Velodrome pool contract who is calling the hook
        // - recipient contracts must not manipulate their own tokenOut balance
        //   (as this may bypass/invalidate the built-in slippage protection)
        // - @developers: never trust balance-based slippage protection for callback recipients
        // - @integrators: do not use slippage guarantees when recipient is a contract with side-effects
        IVelodromeV2Pool(pool).swap(
            amount0Out,
            amount1Out,
            to,
            callback ? abi.encode(tokenIn) : bytes("")
        );
    }
}
