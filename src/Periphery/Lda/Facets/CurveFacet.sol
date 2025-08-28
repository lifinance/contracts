// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ICurve } from "lifi/Interfaces/ICurve.sol";
import { ICurveV2 } from "lifi/Interfaces/ICurveV2.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "lifi/Periphery/LDA/BaseRouteConstants.sol";

/// @title CurveFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles swaps across all Curve pool variants (Legacy, Factory, NG)
/// @dev
/// Pool Types & Interface Selection:
/// 1. Legacy Pools (isV2 = false):
///    - Version <= 0.2.4 (like 3pool, compound, ETH/stETH etc.)
///    - Uses 4-arg exchange(i, j, dx, min_dy)
///    - No receiver param, always sends to msg.sender
///    - Native ETH Support:
///      * When selling ETH (i == 0): Accepts msg.value as input
///      * When buying ETH (j == 0): Returns native ETH via raw_call
///    - We must transfer output tokens manually to destinationAddress
///
/// 2. Modern Pools (isV2 = true):
///    - Factory pools and StableNG pools
///    - Uses 5-arg exchange(i, j, dx, min_dy, receiver)
///    - Direct transfer to specified receiver
///    - For NG pools only: supports optimistic swap via exchange_received
///      when from == address(0) signals tokens were pre-sent
///    - Does not support pure native ETH (uses wrapped versions)
/// @custom:version 1.0.0
contract CurveFacet is BaseRouteConstants {
    using LibPackedStream for uint256;
    using LibAsset for IERC20;

    // ==== External Functions ====
    /// @notice Executes a swap through a Curve pool
    /// @dev
    /// - swapData is tightly packed as:
    ///   [ pool: address,
    ///     isV2: uint8 (0 = 4-arg legacy/main, 1 = 5-arg factory/NG),
    ///     fromIndex: uint8,
    ///     toIndex: uint8,
    ///     destinationAddress: address (receiver for 5-arg; post-transfer target for 4-arg),
    ///     tokenOut: address ]
    /// - `from` controls token sourcing:
    ///     - if `from == msg.sender` and amountIn > 0 - facet pulls `amountIn` from caller,
    ///     - if `from != msg.sender` - tokens are assumed to be already available (e.g., previous hop).
    ///   Special case (NG optimistic): if `isV2 == 1` and `from == address(0)`, the facet calls
    ///   `exchange_received` on NG pools (tokens must have been pre-sent to the pool).
    /// - Indices (i,j) must match the pool's coin ordering.
    /// - Native ETH handling:
    ///   * For legacy pools (isV2 = false):
    ///     - When tokenIn is native: msg.value must equal amountIn
    ///     - When tokenOut is native: balance tracking uses address.balance
    ///   * For modern pools (isV2 = true):
    ///     - Native ETH not supported, use wrapped versions
    /// @param swapData Encoded swap parameters [pool, isV2, fromIndex, toIndex, destinationAddress, tokenOut]
    /// @param from Token source address; if equals msg.sender, tokens will be pulled;
    ///             if set to address(0) with isV2==1, signals NG optimistic hop (tokens pre-sent)
    /// @param tokenIn Input token address (address(0) for native ETH in legacy pools)
    /// @param amountIn Amount of input tokens (ignored for NG optimistic hop)
    function swapCurve(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external payable {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool isV2 = stream.readUint8() > 0; // Convert uint8 to bool. 0 = V1, 1 = V2
        int128 fromIndex = int8(stream.readUint8());
        int128 toIndex = int8(stream.readUint8());
        address destinationAddress = stream.readAddress();
        address tokenOut = stream.readAddress();

        if (pool == address(0) || destinationAddress == address(0))
            revert InvalidCallData();

        if (from == msg.sender) {
            LibAsset.depositAsset(tokenIn, amountIn);
        }

        bool isNativeOut = LibAsset.isNativeAsset(tokenOut);
        bool isNativeIn = LibAsset.isNativeAsset(tokenIn);
        if (!isNativeIn) {
            LibAsset.maxApproveERC20(IERC20(tokenIn), pool, amountIn);
        }

        // Only track balances for legacy path that needs manual transfer. Legacy pools doesn't have receiver param and always sends tokenOut to msg.sender
        uint256 balanceBefore;
        if (!isV2 && destinationAddress != address(this)) {
            balanceBefore = isNativeOut
                ? address(this).balance
                : IERC20(tokenOut).balanceOf(address(this));
        }

        if (isV2) {
            if (from == FUNDS_IN_RECEIVER) {
                // Optimistic NG hop: tokens already sent to pool by previous hop.
                // NG requires _dx > 0 and asserts actual delta >= _dx.
                ICurveV2(pool).exchange_received(
                    fromIndex,
                    toIndex,
                    1, // minimal positive hint
                    0,
                    destinationAddress
                );
            } else {
                // Modern pools do not use pure native ETH path. They use WETH instead
                ICurveV2(pool).exchange(
                    fromIndex,
                    toIndex,
                    amountIn,
                    0,
                    destinationAddress
                );
            }
        } else {
            // Legacy pools can accept/return native ETH
            ICurve(pool).exchange{ value: isNativeIn ? amountIn : 0 }(
                fromIndex,
                toIndex,
                amountIn,
                0
            );
        }

        // Only transfer when legacy path kept tokens on this contract
        if (!isV2 && destinationAddress != address(this)) {
            uint256 balanceAfter = isNativeOut
                ? address(this).balance
                : IERC20(tokenOut).balanceOf(address(this));

            LibAsset.transferAsset(
                tokenOut,
                payable(destinationAddress),
                balanceAfter - balanceBefore
            );
        }
    }
}
