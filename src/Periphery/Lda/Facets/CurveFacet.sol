// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibInputStream } from "../../../Libraries/LibInputStream.sol";
import { LibCallbackManager } from "../../../Libraries/LibCallbackManager.sol";
import { LibAsset } from "../../../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ICurve } from "../../../Interfaces/ICurve.sol";
import { ICurveLegacy } from "../../../Interfaces/ICurveLegacy.sol";
import { InvalidCallData } from "../../../Errors/GenericErrors.sol";

/// @title Curve Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles Curve swaps with callback management
/// @custom:version 1.0.0
contract CurveFacet {
    using LibInputStream for uint256;
    using SafeERC20 for IERC20;
    using LibAsset for IERC20;

    /// Constants ///
    address internal constant NATIVE_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

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

        uint256 amountOut;
        if (tokenIn == NATIVE_ADDRESS) {
            amountOut = ICurve(pool).exchange{ value: amountIn }(
                fromIndex,
                toIndex,
                amountIn,
                0
            );
        } else {
            if (from == msg.sender) {
                IERC20(tokenIn).safeTransferFrom(
                    msg.sender,
                    address(this),
                    amountIn
                );
            }
            IERC20(tokenIn).approveSafe(pool, amountIn);
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
            if (tokenOut == NATIVE_ADDRESS) {
                LibAsset.transferNative(to, amountOut);
            } else {
                IERC20(tokenOut).safeTransfer(to, amountOut);
            }
        }

        return amountOut;
    }
}