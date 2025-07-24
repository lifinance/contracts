// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";
import { ISyncSwapPool } from "lifi/Interfaces/ISyncSwapPool.sol";
import { ISyncSwapVault } from "lifi/Interfaces/ISyncSwapVault.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title SyncSwap Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles SyncSwap swaps with callback management
/// @custom:version 1.0.0
contract SyncSwapFacet {
    using LibInputStream for uint256;
    using SafeERC20 for IERC20;

    /// @notice Performs a swap through SyncSwap pools
    /// @dev This function handles both X to Y and Y to X swaps through SyncSwap pools.
    ///      See [SyncSwap API documentation](https://docs.syncswap.xyz/api-documentation) for protocol details.
    /// @param stream [pool, to, withdrawMode, isV1Pool, vault]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapSyncSwap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256) {
        address pool = stream.readAddress();
        address to = stream.readAddress();

        if (pool == address(0) || to == address(0)) revert InvalidCallData();

        // withdrawMode meaning for SyncSwap via vault:
        //   1: Withdraw raw ETH (native)
        //   2: Withdraw WETH (wrapped)
        //   0: Let the vault decide (ETH for native, WETH for wrapped)
        // For ERC-20 tokens the vault just withdraws the ERC-20
        // and this mode byte is read and ignored by the ERC-20 branch.
        uint8 withdrawMode = stream.readUint8();

        if (withdrawMode > 2) revert InvalidCallData();

        bool isV1Pool = stream.readUint8() == 1;

        address target = isV1Pool ? stream.readAddress() : pool; // target is the vault for V1 pools, the pool for V2 pools
        if (isV1Pool && target == address(0)) revert InvalidCallData();

        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, target, amountIn);
        } else if (from == address(this)) {
            IERC20(tokenIn).safeTransfer(target, amountIn);
        }
        // if from is not msg.sender or address(this), it must be INTERNAL_INPUT_SOURCE
        // which means tokens are already in the vault/pool, no transfer needed

        if (isV1Pool) {
            ISyncSwapVault(target).deposit(tokenIn, pool);
        }

        bytes memory data = abi.encode(tokenIn, to, withdrawMode);

        ISyncSwapPool(pool).swap(data, from, address(0), new bytes(0));

        return 0; // Return value not used in current implementation
    }
}
