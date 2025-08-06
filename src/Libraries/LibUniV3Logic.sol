// SPDX-License-Identifier: LGPL-3.0-only
/// @custom:version 1.0.0
pragma solidity ^0.8.17;

import { LibInputStream } from "./LibInputStream.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title UniV3 Logic Library
/// @author LI.FI (https://li.fi)
/// @notice Shared logic for UniV3-style DEX protocols
library LibUniV3Logic {
    using SafeERC20 for IERC20;
    using LibInputStream for uint256;

    /// @notice Handles a generic UniV3-style callback
    /// @param amount0Delta The amount of token0 owed to pool
    /// @param amount1Delta The amount of token1 owed to pool
    /// @param data The callback data containing tokenIn address
    function handleCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) internal {
        int256 amount = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (amount <= 0) {
            return; // Nothing to pay
        }

        address tokenIn = abi.decode(data, (address));
        IERC20(tokenIn).safeTransfer(msg.sender, uint256(amount));
    }
}
