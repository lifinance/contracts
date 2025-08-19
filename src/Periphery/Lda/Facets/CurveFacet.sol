// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ICurve } from "lifi/Interfaces/ICurve.sol";
import { ICurveLegacy } from "lifi/Interfaces/ICurveLegacy.sol";

/// @title Curve Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles Curve swaps with callback management
/// @custom:version 1.0.0
contract CurveFacet {
    using LibInputStream for uint256;
    using LibAsset for IERC20;

    // ==== External Functions ====
    /// @notice Curve pool swap. Legacy pools that don't return amountOut and have native coins are not supported
    /// @param stream [pool, poolType, fromIndex, toIndex, recipient, output token]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapCurve(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        address pool = stream.readAddress();
        uint8 poolType = stream.readUint8();
        int128 fromIndex = int8(stream.readUint8());
        int128 toIndex = int8(stream.readUint8());
        address to = stream.readAddress();
        address tokenOut = stream.readAddress();

        // TODO arm callback protection

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

        if (to != address(this)) {
            LibAsset.transferAsset(tokenOut, payable(to), amountOut);
        }

        return amountOut;
    }
}
