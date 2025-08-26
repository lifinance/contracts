// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ICurve } from "lifi/Interfaces/ICurve.sol";
import { ICurveV2 } from "lifi/Interfaces/ICurveV2.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title CurveFacet
/// @author LI.FI (https://li.fi)
/// @notice Swaps via Curve pools across legacy/main (4-arg) and factory/NG (5-arg) interfaces.
/// @dev
/// - Pool interface selection is driven by `isV2`.
///   - isV2 = false → legacy/main pools exposing `exchange(i,j,dx,min_dy)` (4 args).
///   - isV2 = true  → modern pools exposing `exchange(i,j,dx,min_dy,receiver)` (5 args),
///                    which includes Factory pools and Stable NG pools.
/// - NG-only “optimistic” swaps: NG pools also implement `exchange_received(...)`.
///   This facet will call `exchange_received` iff:
///     (a) isV2 == true, and
///     (b) `from == address(0)` is provided by the route, signaling the tokens were pre-sent
///         to the pool by a previous hop. In that case we pass a small positive dx (1) as a hint.
///   Notes/constraints for NG:
///     - `_dx` MUST be > 0 (pool asserts actual delta ≥ _dx).
///     - Reverts if the pool contains rebasing tokens.
/// - Amount out is always computed via balanceBefore/After:
///     - For 5-arg pools (isV2=true) we measure at `destinationAddress`.
///     - For 4-arg pools (isV2=false) we measure at this contract and forward tokens afterwards.
/// - Native ETH is not supported (use ERC20).
/// @custom:version 1.0.0
contract CurveFacet {
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
    /// - Indices (i,j) must match the pool’s coin ordering.
    /// @param swapData Encoded swap parameters [pool, isV2, fromIndex, toIndex, destinationAddress, tokenOut]
    /// @param from Token source address; if equals msg.sender, tokens will be pulled;
    ///             if set to address(0) with isV2==1, signals NG optimistic hop (tokens pre-sent)
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens (ignored for NG optimistic hop)
    function swapCurve(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        bool isV2 = stream.readUint8() > 0; // Convert uint8 to bool. 0 = V1, 1 = V2
        int128 fromIndex = int8(stream.readUint8());
        int128 toIndex = int8(stream.readUint8());
        address destinationAddress = stream.readAddress();
        address tokenOut = stream.readAddress();

        if (pool == address(0) || destinationAddress == address(0))
            revert InvalidCallData();

        uint256 amountOut;

        if (from == msg.sender && amountIn > 0) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        LibAsset.maxApproveERC20(IERC20(tokenIn), pool, amountIn);

        // Track balances at the actual receiver for V2, otherwise at this contract
        address balAccount = isV2 ? destinationAddress : address(this);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(balAccount);

        if (isV2) {
            if (from == address(0)) {
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
                ICurveV2(pool).exchange(
                    fromIndex,
                    toIndex,
                    amountIn,
                    0,
                    destinationAddress
                );
            }
        } else {
            ICurve(pool).exchange(fromIndex, toIndex, amountIn, 0);
        }

        uint256 balanceAfter = IERC20(tokenOut).balanceOf(balAccount);
        amountOut = balanceAfter - balanceBefore;

        // Only transfer when legacy path kept tokens on this contract
        if (!isV2 && destinationAddress != address(this)) {
            LibAsset.transferAsset(
                tokenOut,
                payable(destinationAddress),
                amountOut
            );
        }
    }
}
