// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "./LibAsset.sol";
import { LibUtil } from "./LibUtil.sol";
import { InvalidContract, NoSwapFromZeroBalance } from "../Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title LibSwap
/// @custom:version 1.1.0
/// @notice This library contains functionality to execute mostly swaps but also
///         other calls such as fee collection, token wrapping/unwrapping or
///         sending gas to destination chain
library LibSwap {
    /// @notice Struct containing all necessary data to execute a swap or generic call
    /// @param callTo The address of the contract to call for executing the swap
    /// @param approveTo The address that will receive token approval (can be different than callTo for some DEXs)
    /// @param sendingAssetId The address of the token being sent
    /// @param receivingAssetId The address of the token expected to be received
    /// @param fromAmount The exact amount of the sending asset to be used in the call
    /// @param callData Encoded function call data to be sent to the `callTo` contract
    /// @param requiresDeposit A flag indicating whether the tokens must be deposited (pulled) before the call
    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    /// @notice Emitted after a successful asset swap or related operation
    /// @param transactionId    The unique identifier associated with the swap operation
    /// @param dex              The address of the DEX or contract that handled the swap
    /// @param fromAssetId      The address of the token that was sent
    /// @param toAssetId        The address of the token that was received
    /// @param fromAmount       The amount of `fromAssetId` sent
    /// @param toAmount         The amount of `toAssetId` received
    /// @param timestamp        The timestamp when the swap was executed
    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );

    function swap(bytes32 transactionId, SwapData calldata _swap) internal {
        // make sure callTo is a contract
        if (!LibAsset.isContract(_swap.callTo)) revert InvalidContract();

        // make sure that fromAmount is not 0
        uint256 fromAmount = _swap.fromAmount;
        if (fromAmount == 0) revert NoSwapFromZeroBalance();

        // determine how much native value to send with the swap call
        uint256 nativeValue = LibAsset.isNativeAsset(_swap.sendingAssetId)
            ? _swap.fromAmount
            : 0;

        // store initial balance (required for event emission)
        uint256 initialReceivingAssetBalance = LibAsset.getOwnBalance(
            _swap.receivingAssetId
        );

        // max approve (if ERC20)
        if (nativeValue == 0) {
            LibAsset.maxApproveERC20(
                IERC20(_swap.sendingAssetId),
                _swap.approveTo,
                _swap.fromAmount
            );
        }

        // we used to have a sending asset balance check here (initialSendingAssetBalance >= _swap.fromAmount)
        // this check was removed to allow for more flexibility with rebasing/fee-taking tokens
        // the general assumption is that if not enough tokens are available to execute the calldata,
        // the transaction will fail anyway
        // the error message might not be as explicit though

        // execute the swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swap.callTo.call{
            value: nativeValue
        }(_swap.callData);
        if (!success) {
            LibUtil.revertWith(res);
        }

        // get post-swap balance
        uint256 newBalance = LibAsset.getOwnBalance(_swap.receivingAssetId);

        // emit event
        emit AssetSwapped(
            transactionId,
            _swap.callTo,
            _swap.sendingAssetId,
            _swap.receivingAssetId,
            _swap.fromAmount,
            newBalance > initialReceivingAssetBalance
                ? newBalance - initialReceivingAssetBalance
                : newBalance,
            block.timestamp
        );
    }
}
