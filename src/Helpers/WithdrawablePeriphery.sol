// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { TransferrableOwnership } from "./TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ExternalCallFailed } from "../Errors/GenericErrors.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

abstract contract WithdrawablePeriphery is TransferrableOwnership {
    using SafeTransferLib for address;

    event TokensWithdrawn(
        address assetId,
        address payable receiver,
        uint256 amount
    );

    constructor(address _owner) TransferrableOwnership(_owner) {}

    function withdrawToken(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (LibAsset.isNativeAsset(assetId)) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = receiver.call{ value: amount }("");
            if (!success) revert ExternalCallFailed();
        } else {
            assetId.safeTransfer(receiver, amount);
        }

        emit TokensWithdrawn(assetId, receiver, amount);
    }
}
