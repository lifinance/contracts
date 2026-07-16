// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "./TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ExternalCallFailed } from "../Errors/GenericErrors.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

// TODO(EXSC-241): route withdrawToken through LibAsset.transferAsset and add a
//                 ZeroAmount check. Deferred because this contract is inherited
//                 by many periphery contracts; bumping it here would force
//                 redeploys of all inheritors or drift the repo from deployed
//                 bytecode. Re-enable once EXSC-330 (commit hash stored in
//                 deploy log) makes that drift recoverable via re-verification.
/// @custom:version 1.0.0
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
