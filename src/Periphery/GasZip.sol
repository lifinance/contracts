// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

interface IGasZip {
    function deposit(
        uint256 destinationChain,
        address recipient
    ) external payable;
}

/// @title GasZip
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap and trigger gaz.zip protocol
/// @custom:version 1.0.0
contract GasZip is TransferrableOwnership {
    address public immutable ZERO = address(0);

    /// State ///
    IGasZip public immutable gasZipRouter;

    /// Errors ///
    error SwapFailed(address, address);
    error GasZipFailed(uint256);
    error TransferFailed();
    error InboundTokenDisallowed();

    /// Events ///

    /// Constructor ///
    constructor(
        address _owner,
        address _gasZipRouter
    ) TransferrableOwnership(_owner) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    function zipERC20(
        LibSwap.SwapData calldata _swap,
        uint256 destinationChain,
        address recipient
    ) public {
        LibSwap.swap(0, _swap);
        uint256 availableNative = LibAsset.getOwnBalance(ZERO);
        gasZipRouter.deposit{ value: availableNative }(
            destinationChain,
            recipient
        );

        // Send back any remaining sendingAsset token to the sender
        IERC20 sendingAsset = IERC20(_swap.sendingAssetId);
        uint256 remainingBalance = sendingAsset.balanceOf(address(this));

        if (remainingBalance > 0) {
            bool success = sendingAsset.transfer(msg.sender, remainingBalance);
            if (!success) revert TransferFailed();
        }
    }

    function zip(
        uint256 amountToZip,
        uint256 destinationChain,
        address recipient
    ) public payable {
        gasZipRouter.deposit{ value: amountToZip }(
            destinationChain,
            recipient
        );
        uint256 nativeBalance = address(this).balance;

        if (nativeBalance > 0) {
            (bool success, ) = msg.sender.call{ value: address(this).balance }(
                ""
            );
            if (!success) revert TransferFailed();
        }
    }
}
