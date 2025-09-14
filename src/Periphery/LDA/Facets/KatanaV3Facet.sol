// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { IKatanaV3Pool } from "lifi/Interfaces/KatanaV3/IKatanaV3Pool.sol";
import { IKatanaV3Governance } from "lifi/Interfaces/KatanaV3/IKatanaV3Governance.sol";
import { IKatanaV3AggregateRouter } from "lifi/Interfaces/KatanaV3/IKatanaV3AggregateRouter.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title KatanaV3Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles KatanaV3 swaps. Callbacks are on the router contract itself.
/// @custom:version 1.0.0
contract KatanaV3Facet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== Constants ====
    /// @dev KatanaV3 swap command for exact input
    bytes internal constant KATANA_V3_SWAP_EXACT_IN = hex"00";

    // ==== External Functions ====
    /// @notice Performs a swap through KatanaV3 pools
    /// @dev This function handles swaps through KatanaV3 pools.
    /// @param swapData Encoded swap parameters [pool, direction, destinationAddress]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapKatanaV3(
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

        // get router address from pool governance
        address governance = IKatanaV3Pool(pool).governance();
        address router = IKatanaV3Governance(governance).getRouter();

        // get pool info for constructing the path
        uint24 fee = IKatanaV3Pool(pool).fee();

        // determine tokenOut based on swap direction
        address tokenOut = direction
            ? IKatanaV3Pool(pool).token1()
            : IKatanaV3Pool(pool).token0();

        // transfer tokens to the router
        if (from == msg.sender) {
            LibAsset.transferFromERC20(tokenIn, msg.sender, router, amountIn);
        } else if (from == address(this)) {
            LibAsset.transferERC20(tokenIn, router, amountIn);
        }

        // encode the inputs for V3_SWAP_EXACT_IN
        // set payerIsUser to false since we already transferred tokens to the router
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            destinationAddress, // destinationAddress
            amountIn, // amountIn
            0, // amountOutMin (0, as we handle slippage at higher level)
            abi.encodePacked(tokenIn, fee, tokenOut), // construct the path for V3 swap (tokenIn -> tokenOut with fee)
            false // payerIsUser (false since tokens are already in router)
        );

        // call the router's execute function
        // first parameter for execute is the command for V3_SWAP_EXACT_IN (0x00)
        IKatanaV3AggregateRouter(router).execute(
            KATANA_V3_SWAP_EXACT_IN,
            inputs
        );

        // katanaV3SwapCallback implementation is in the router contract itself
    }
}
