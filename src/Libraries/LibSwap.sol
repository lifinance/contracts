// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { LibAsset, IERC20 } from "./LibAsset.sol";
import { LibUtil } from "./LibUtil.sol";

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
        uint256 fromAmount = _swapData.fromAmount;
        require(fromAmount > 0, "Cannot swap from 0 balance.");
        uint256 nativeValue = 0;
        uint256 toAmount = LibAsset.getOwnBalance(_swapData.receivingAssetId);
        address fromAssetId = _swapData.sendingAssetId;

        if (!LibAsset.isNativeAsset(fromAssetId)) {
            LibAsset.maxApproveERC20(IERC20(fromAssetId), _swapData.approveTo, fromAmount);
            if (LibAsset.getOwnBalance(fromAssetId) < fromAmount) {
                LibAsset.transferFromERC20(fromAssetId, msg.sender, address(this), fromAmount);
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

        toAmount = LibAsset.getOwnBalance(_swapData.receivingAssetId) - toAmount;
        emit AssetSwapped(
            transactionId,
            _swapData.callTo,
            _swapData.sendingAssetId,
            _swapData.receivingAssetId,
            fromAmount,
            toAmount,
            block.timestamp
        );
    }
}
