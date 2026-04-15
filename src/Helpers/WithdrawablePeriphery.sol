// SPDX-License-Identifier: LGPL-3.0-only
/// @custom:version 1.0.1
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "./TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ExternalCallFailed } from "../Errors/GenericErrors.sol";

abstract contract WithdrawablePeriphery is TransferrableOwnership {
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
            LibAsset.transferERC20(assetId, receiver, amount);
        }

        emit TokensWithdrawn(assetId, receiver, amount);
    }
}
