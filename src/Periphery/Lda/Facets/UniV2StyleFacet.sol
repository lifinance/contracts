// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

interface IUniswapV2Pair {
    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}

/// @title UniV2Style Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles UniswapV2-style swaps (UniV2, SushiSwap, PancakeV2, etc.)
/// @custom:version 2.0.0
contract UniV2StyleFacet {
    using LibInputStream for uint256;

    // ==== Constants ====
    address internal constant INTERNAL_INPUT_SOURCE = address(0);
    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;

    // ==== Errors ====
    error WrongPoolReserves();

    // ==== External Functions ====
    /// @notice Executes a UniswapV2-style swap
    /// @param stream The input stream containing swap parameters
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapUniV2(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8();
        address to = stream.readAddress();
        uint24 fee = stream.readUint24(); // pool fee in 1/1_000_000

        if (pool == address(0) || to == address(0)) {
            revert InvalidCallData();
        }

        // Transfer tokens to pool if needed
        if (from == address(this)) {
            LibAsset.transferERC20(tokenIn, pool, amountIn);
        } else if (from == msg.sender) {
            LibAsset.transferFromERC20(tokenIn, msg.sender, pool, amountIn);
        }

        // Get reserves and calculate output
        (uint256 r0, uint256 r1, ) = IUniswapV2Pair(pool).getReserves();
        if (r0 == 0 || r1 == 0) revert WrongPoolReserves();

        (uint256 reserveIn, uint256 reserveOut) = direction ==
            DIRECTION_TOKEN0_TO_TOKEN1
            ? (r0, r1)
            : (r1, r0);

        // Calculate actual input amount from pool balance
        amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn;

        uint256 amountInWithFee = amountIn * (1_000_000 - fee);
        amountOut =
            (amountInWithFee * reserveOut) /
            (reserveIn * 1_000_000 + amountInWithFee);

        (uint256 amount0Out, uint256 amount1Out) = direction ==
            DIRECTION_TOKEN0_TO_TOKEN1
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IUniswapV2Pair(pool).swap(amount0Out, amount1Out, to, new bytes(0));
    }
}
