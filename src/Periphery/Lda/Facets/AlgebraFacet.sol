// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibInputStream } from "../../../Libraries/LibInputStream.sol";
import { LibCallbackManager } from "../../../Libraries/LibCallbackManager.sol";
import { LibUniV3Logic } from "../../../Libraries/LibUniV3Logic.sol";
import { IAlgebraPool } from "../../../Interfaces/IAlgebraPool.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { InvalidCallData } from "../../../Errors/GenericErrors.sol";

/// @title Algebra Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles Algebra swaps with callback management
/// @custom:version 1.0.0
contract AlgebraFacet {
    using LibInputStream for uint256;
    using SafeERC20 for IERC20;

    /// Constants ///
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    address internal constant IMPOSSIBLE_POOL_ADDRESS = 0x0000000000000000000000000000000000000001;

    /// Errors ///
    error AlgebraSwapUnexpected();

    function swapAlgebra(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        address pool = stream.readAddress();
        bool direction = stream.readUint8() > 0;
        address recipient = stream.readAddress();
        bool supportsFeeOnTransfer = stream.readUint8() > 0;

        if (
            pool == address(0) ||
            pool == IMPOSSIBLE_POOL_ADDRESS ||
            recipient == address(0)
        ) revert InvalidCallData();

        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                uint256(amountIn)
            );
        }

        LibCallbackManager.arm(pool);

        if (supportsFeeOnTransfer) {
            IAlgebraPool(pool).swapSupportingFeeOnInputTokens(
                address(this),
                recipient,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        } else {
            IAlgebraPool(pool).swap(
                recipient,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        }

        if (LibCallbackManager.data().expected != IMPOSSIBLE_POOL_ADDRESS) {
            revert AlgebraSwapUnexpected();
        }
            
        return 0; // Actual output amount tracked via balance checks in CoreFacet
    }

    function algebraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external LibCallbackManager.onlyExpectedCallback {
        LibUniV3Logic.handleCallback(amount0Delta, amount1Delta, data);
    }
}