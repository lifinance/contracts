// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { IUniV2StylePool } from "lifi/Interfaces/IUniV2StylePool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title UniV2StyleFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles UniswapV2-style swaps (UniV2, SushiSwap, PancakeV2, etc.)
/// @custom:version 1.0.0
contract UniV2StyleFacet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== Constants ====
    /// @dev Fee denominator for UniV2-style pools (100% = 1_000_000)
    uint256 private constant FEE_DENOMINATOR = 1_000_000;

    // ==== Errors ====
    /// @dev Thrown when pool reserves are zero, indicating an invalid pool state
    error WrongPoolReserves();

    // ==== External Functions ====
    /// @notice Executes a UniswapV2-style swap
    /// @dev Handles token transfers and calculates output amounts based on pool reserves
    /// @param swapData Encoded swap parameters [pool, direction, destinationAddress, fee]
    /// @param from Token source address - if equals msg.sender or this contract, tokens will be transferred;
    ///        otherwise assumes tokens are at receiver address (FUNDS_IN_RECEIVER)
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapUniV2(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1;
        address destinationAddress = stream.readAddress();
        uint24 fee = stream.readUint24(); // pool fee in 1/1_000_000

        if (
            pool == address(0) ||
            destinationAddress == address(0) ||
            fee >= FEE_DENOMINATOR
        ) {
            revert InvalidCallData();
        }

        // Transfer tokens to pool if needed
        if (from == address(this)) {
            LibAsset.transferERC20(tokenIn, pool, amountIn);
        } else if (from == msg.sender) {
            LibAsset.transferFromERC20(tokenIn, msg.sender, pool, amountIn);
        }

        // Get reserves and calculate output
        (uint256 r0, uint256 r1, ) = IUniV2StylePool(pool).getReserves();
        if (r0 == 0 || r1 == 0) revert WrongPoolReserves();

        (uint256 reserveIn, uint256 reserveOut) = direction
            ? (r0, r1)
            : (r1, r0);

        // Calculate actual input amount from pool balance
        amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn;

        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - fee);
        uint256 amountOut = (amountInWithFee * reserveOut) /
            (reserveIn * FEE_DENOMINATOR + amountInWithFee);

        (uint256 amount0Out, uint256 amount1Out) = direction
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IUniV2StylePool(pool).swap(
            amount0Out,
            amount1Out,
            destinationAddress,
            new bytes(0)
        );
    }
}
