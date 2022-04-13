// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { LibAsset, IERC20 } from "./LibAsset.sol";
import { LibUtil } from "./LibUtil.sol";
import { InvalidContract } from "../Errors/GenericErrors.sol";

library LibSwap {
    error NoSwapFromZeroBalance();

    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
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

    function swap(bytes32 transactionId, SwapData calldata _swapData) internal {
        if (!LibAsset.isContract(_swapData.callTo)) revert InvalidContract();
        uint256 fromAmount = _swapData.fromAmount;
        if (fromAmount == 0) revert NoSwapFromZeroBalance();
        uint256 nativeValue = 0;
        address fromAssetId = _swapData.sendingAssetId;
        address toAssetId = _swapData.receivingAssetId;
        uint256 initialSendingAssetBalance = LibAsset.getOwnBalance(fromAssetId);
        uint256 initialReceivingAssetBalance = LibAsset.getOwnBalance(toAssetId);
        uint256 toDeposit = initialSendingAssetBalance < fromAmount ? fromAmount - initialSendingAssetBalance : 0;

        if (!LibAsset.isNativeAsset(fromAssetId)) {
            LibAsset.maxApproveERC20(IERC20(fromAssetId), _swapData.approveTo, fromAmount);
            if (toDeposit != 0) {
                LibAsset.transferFromERC20(fromAssetId, msg.sender, address(this), toDeposit);
            }
        } else {
            nativeValue = fromAmount;
        }

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call{ value: nativeValue }(_swapData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        emit AssetSwapped(
            transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            toAssetId,
            fromAmount,
            LibAsset.getOwnBalance(toAssetId) - initialReceivingAssetBalance,
            block.timestamp
        );
    }
}
