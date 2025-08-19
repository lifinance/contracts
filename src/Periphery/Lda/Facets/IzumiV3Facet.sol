// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { IiZiSwapPool } from "lifi/Interfaces/IiZiSwapPool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title IzumiV3 Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles IzumiV3 swaps with callback management
/// @custom:version 1.0.0
contract IzumiV3Facet {
    using LibPackedStream for uint256;
    using LibCallbackManager for *;
    using SafeERC20 for IERC20;

    /// @dev iZiSwap pool price points boundaries
    int24 internal constant IZUMI_LEFT_MOST_PT = -800000;
    int24 internal constant IZUMI_RIGHT_MOST_PT = 800000;
    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;

    error IzumiV3SwapUnexpected();
    error IzumiV3SwapCallbackUnknownSource();
    error IzumiV3SwapCallbackNotPositiveAmount();

    /// @notice Performs a swap through iZiSwap V3 pools
    /// @dev This function handles both X to Y and Y to X swaps through iZiSwap V3 pools
    /// @param swapData [pool, direction, recipient]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapIzumiV3(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        uint256 stream = LibPackedStream.createStream(swapData);
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8(); // 0 = Y2X, 1 = X2Y
        address recipient = stream.readAddress();

        if (
            pool == address(0) ||
            recipient == address(0) ||
            amountIn > type(uint128).max
        ) revert InvalidCallData();

        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
        }

        LibCallbackManager.arm(pool);

        if (direction == DIRECTION_TOKEN0_TO_TOKEN1) {
            IiZiSwapPool(pool).swapX2Y(
                recipient,
                uint128(amountIn),
                IZUMI_LEFT_MOST_PT + 1,
                abi.encode(tokenIn)
            );
        } else {
            IiZiSwapPool(pool).swapY2X(
                recipient,
                uint128(amountIn),
                IZUMI_RIGHT_MOST_PT - 1,
                abi.encode(tokenIn)
            );
        }

        // After the swapX2Y or swapY2X call, the callback should clear the registered pool
        // If it hasn't, it means the callback either didn't happen, was incorrect, or the pool misbehaved
        // so we revert to protect against misuse or faulty integrations
        if (LibCallbackManager.callbackStorage().expected != address(0)) {
            revert IzumiV3SwapUnexpected();
        }

        return 0; // Return value not used in current implementation
    }

    function swapX2YCallback(
        uint256 amountX,
        uint256,
        bytes calldata data
    ) external {
        _handleIzumiV3SwapCallback(amountX, data);
    }

    function swapY2XCallback(
        uint256,
        uint256 amountY,
        bytes calldata data
    ) external {
        _handleIzumiV3SwapCallback(amountY, data);
    }

    /// @dev Common logic for iZiSwap callbacks
    /// @param amountToPay The amount of tokens to be sent to the pool
    /// @param data The data passed through by the caller
    function _handleIzumiV3SwapCallback(
        uint256 amountToPay,
        bytes calldata data
    ) private {
        LibCallbackManager.verifyCallbackSender();

        if (amountToPay == 0) {
            revert IzumiV3SwapCallbackNotPositiveAmount();
        }

        address tokenIn = abi.decode(data, (address));
        IERC20(tokenIn).safeTransfer(msg.sender, amountToPay);

        LibCallbackManager.clear();
    }
}
