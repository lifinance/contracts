// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { console2 } from "forge-std/console2.sol";

/// @title VelodromeV2 Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles VelodromeV2 swaps with callback management
/// @custom:version 1.0.0
contract VelodromeV2Facet {
    using LibInputStream for uint256;
    using SafeERC20 for IERC20;

    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;
    uint8 internal constant CALLBACK_ENABLED = 1;
    address internal constant INTERNAL_INPUT_SOURCE = address(0);

    error WrongPoolReserves();

    /// @notice Performs a swap through VelodromeV2 pools
    /// @dev This function does not handle native token swaps directly, so processNative command cannot be used
    /// @param stream [pool, direction, to, callback]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapVelodromeV2(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        console2.log("swapVelodromeV222 here");
        console2.log("stream before reading:");
        console2.logBytes(abi.encode(stream));  // Add this to see the raw stream data
        
        address pool = stream.readAddress();
        console2.log("pool222");
        console2.logAddress(pool);
        uint8 direction = stream.readUint8();
        console2.log("direction222");
        console2.log(direction);
        address to = stream.readAddress();
        console2.log("to222");
        console2.logAddress(to);
        if (pool == address(0) || to == address(0)) revert InvalidCallData();
        // solhint-disable-next-line max-line-length
        bool callback = stream.readUint8() == CALLBACK_ENABLED; // if true then run callback after swap with tokenIn as flashloan data. Will revert if contract (to) does not implement IVelodromeV2PoolCallee

        if (from == INTERNAL_INPUT_SOURCE) {
            (uint256 reserve0, uint256 reserve1, ) = IVelodromeV2Pool(pool)
                .getReserves();
            if (reserve0 == 0 || reserve1 == 0) revert WrongPoolReserves();
            uint256 reserveIn = direction == DIRECTION_TOKEN0_TO_TOKEN1
                ? reserve0
                : reserve1;

            amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn;
        } else {
            if (from == address(this))
                IERC20(tokenIn).safeTransfer(pool, amountIn);
            else if (from == msg.sender)
                IERC20(tokenIn).safeTransferFrom(msg.sender, pool, amountIn);
        }

        // calculate the expected output amount using the pool's getAmountOut function
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

        return 0; // Return value not used in current implementation
    }
}
