// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ICurve } from "lifi/Interfaces/ICurve.sol";
import { ICurveLegacy } from "lifi/Interfaces/ICurveLegacy.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title CurveFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles Curve pool swaps for both legacy and modern pools
/// @dev Implements direct selector-callable swap function for Curve pools with balance tracking for legacy pools
/// @custom:version 1.0.0
contract CurveFacet {
    using LibPackedStream for uint256;
    using LibAsset for IERC20;

    // ==== External Functions ====
    /// @notice Executes a swap through a Curve pool
    /// @dev Handles both modern pools that return amounts and legacy pools that require balance tracking
    /// @param swapData Encoded swap parameters [pool, poolType, fromIndex, toIndex, recipient, tokenOut]
    /// @param from Token source address - if equals msg.sender, tokens will be pulled from the caller;
    ///        otherwise assumes tokens are already at this contract
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapCurve(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        uint8 poolType = stream.readUint8();
        int128 fromIndex = int8(stream.readUint8());
        int128 toIndex = int8(stream.readUint8());
        address recipient = stream.readAddress();
        address tokenOut = stream.readAddress();

        if (pool == address(0) || recipient == address(0))
            revert InvalidCallData();

        uint256 amountOut;
        if (LibAsset.isNativeAsset(tokenIn)) {
            amountOut = ICurve(pool).exchange{ value: amountIn }(
                fromIndex,
                toIndex,
                amountIn,
                0
            );
        } else {
            if (from == msg.sender) {
                LibAsset.transferFromERC20(
                    tokenIn,
                    msg.sender,
                    address(this),
                    amountIn
                );
            }
            LibAsset.maxApproveERC20(IERC20(tokenIn), pool, amountIn);
            if (poolType == 0) {
                amountOut = ICurve(pool).exchange(
                    fromIndex,
                    toIndex,
                    amountIn,
                    0
                );
            } else {
                uint256 balanceBefore = IERC20(tokenOut).balanceOf(
                    address(this)
                );
                ICurveLegacy(pool).exchange(fromIndex, toIndex, amountIn, 0);
                uint256 balanceAfter = IERC20(tokenOut).balanceOf(
                    address(this)
                );
                amountOut = balanceAfter - balanceBefore;
            }
        }

        if (recipient != address(this)) {
            LibAsset.transferAsset(tokenOut, payable(recipient), amountOut);
        }
    }
}
