// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { LibAsset, IERC20 } from "./LibAsset.sol";
import { LibUtil } from "./LibUtil.sol";
import { InvalidContract, NoSwapFromZeroBalance, InsufficientBalance } from "../Errors/GenericErrors.sol";

library LibSwap {
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
        if (_swapData.fromAmount == 0) revert NoSwapFromZeroBalance();

        uint256 nativeValue = LibAsset.isNativeAsset(_swapData.sendingAssetId) ? _swapData.fromAmount : 0;
        uint256 initialSendingAssetBalance = LibAsset.getOwnBalance(_swapData.sendingAssetId);
        uint256 initialReceivingAssetBalance = LibAsset.getOwnBalance(_swapData.receivingAssetId);

        if (nativeValue == 0) {
            LibAsset.maxApproveERC20(IERC20(_swapData.sendingAssetId), _swapData.approveTo, _swapData.fromAmount);
        }

        if (initialSendingAssetBalance < _swapData.fromAmount) {
            revert InsufficientBalance(_swapData.fromAmount, initialSendingAssetBalance);
        }

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swapData.callTo.call{ value: nativeValue }(_swapData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }

        uint256 newBalance = LibAsset.getOwnBalance(_swapData.receivingAssetId);

        emit AssetSwapped(
            transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            _swapData.fromAmount,
            newBalance > initialReceivingAssetBalance ? newBalance - initialReceivingAssetBalance : newBalance,
            block.timestamp
        );
    }
}
