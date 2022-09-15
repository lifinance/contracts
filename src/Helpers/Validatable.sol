// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;
import { InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract Validatable {
    modifier validateReceiver(address recipient) {
        if (LibUtil.isZeroAddress(recipient)) revert InvalidReceiver();
        _;
    }

    modifier validateAmount(uint256 amount) {
        if (amount == 0) revert InvalidAmount();
        _;
    }

    modifier validateMsgValue(address assetId, uint256 amount) {
        if (LibAsset.isNativeAsset(assetId)) {
            if (msg.value < amount) revert InvalidAmount();
        }
        _;
    }
}
