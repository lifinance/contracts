// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { LibAsset, IERC20 } from "./LibAsset.sol";
import { LibUtil } from "./LibUtil.sol";
import { InvalidContract, NoSwapFromZeroBalance } from "../Errors/GenericErrors.sol";

library LibSwap {
    struct Swap {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    struct SwapData {
        Swap[] swaps;
        uint256 minReturnAmount;
    }

    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );

    function swap(bytes32 transactionId, Swap calldata _swap) internal {
        if (!LibAsset.isContract(_swap.callTo)) revert InvalidContract();
        uint256 fromAmount = _swap.fromAmount;
        if (fromAmount == 0) revert NoSwapFromZeroBalance();
        uint256 nativeValue = 0;
        address fromAssetId = _swap.sendingAssetId;
        address toAssetId = _swap.receivingAssetId;
        uint256 initialSendingAssetBalance = LibAsset.getOwnBalance(fromAssetId);
        uint256 initialReceivingAssetBalance = LibAsset.getOwnBalance(toAssetId);
        uint256 toDeposit = initialSendingAssetBalance < fromAmount ? fromAmount - initialSendingAssetBalance : 0;

        if (!LibAsset.isNativeAsset(fromAssetId)) {
            LibAsset.maxApproveERC20(IERC20(fromAssetId), _swap.approveTo, fromAmount);
            if (toDeposit != 0) {
                LibAsset.transferFromERC20(fromAssetId, msg.sender, address(this), toDeposit);
            }
        } else {
            nativeValue = fromAmount;
        }

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swap.callTo.call{ value: nativeValue }(_swap.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        uint256 newBalance = LibAsset.getOwnBalance(toAssetId);

        emit AssetSwapped(
            transactionId,
            _swap.callTo,
            _swap.sendingAssetId,
            toAssetId,
            fromAmount,
            newBalance > initialReceivingAssetBalance ? newBalance - initialReceivingAssetBalance : newBalance,
            block.timestamp
        );
    }
}
