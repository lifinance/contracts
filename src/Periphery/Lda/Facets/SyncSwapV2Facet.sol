// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ISyncSwapPool } from "lifi/Interfaces/ISyncSwapPool.sol";
import { ISyncSwapVault } from "lifi/Interfaces/ISyncSwapVault.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title SyncSwapV2Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles SyncSwap V2 pool swaps with vault integration
/// @dev Supports both V1 and V2 SyncSwap pools
/// @custom:version 1.0.0
contract SyncSwapV2Facet {
    using LibPackedStream for uint256;

    /// @notice Executes a swap through a SyncSwap V2 pool
    /// @dev Handles both V1 (vault-based) and V2 (direct) pool swaps
    /// @param swapData Encoded swap parameters [pool, destinationAddress, withdrawMode, isV1Pool, vault]
    /// @param from Token source address - if equals msg.sender or this contract, tokens will be transferred;
    ///        otherwise assumes tokens are at receiver address
    /// @param tokenIn Input token address
    /// @param amountIn Amount of input tokens
    function swapSyncSwapV2(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address pool = stream.readAddress();
        address destinationAddress = stream.readAddress();

        if (pool == address(0) || destinationAddress == address(0))
            revert InvalidCallData();

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
            LibAsset.transferFromERC20(tokenIn, msg.sender, target, amountIn);
        } else if (from == address(this)) {
            LibAsset.transferERC20(tokenIn, target, amountIn);
        }
        // if from is not msg.sender or address(this), it must be FUNDS_IN_RECEIVER
        // which means tokens are already in the vault/pool, no transfer needed

        // SyncSwap V1 pools require tokens to be deposited into their vault first
        // before they can be used for swapping
        if (isV1Pool) {
            ISyncSwapVault(target).deposit(tokenIn, pool);
        }

        bytes memory data = abi.encode(
            tokenIn,
            destinationAddress,
            withdrawMode
        );

        ISyncSwapPool(pool).swap(data, from, address(0), new bytes(0));
    }
}
