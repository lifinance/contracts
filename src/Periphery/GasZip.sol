// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

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

    mapping(address => bool) public allowedInboundTokens;
    IGasZip public immutable gasZipRouter;

    /// Errors ///
    error SwapFailed(address, address);
    error GasZipFailed(uint256);
    error TransferFailed();
    error InboundTokenDisallowed();

    /// Events ///

    /// Constructor ///

    modifier inboundTokenIsAllowed(address token) {
        if (!allowedInboundTokens[token]) revert InboundTokenDisallowed();
        _;
    }

    constructor(
        address _owner,
        address _gasZipRouter
    ) TransferrableOwnership(_owner) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    function allowToken(address token, bool allowed) external onlyOwner {
        allowedInboundTokens[token] = allowed;
    }

    function zipERC20(
        LibSwap.SwapData calldata _swap,
        uint256 destinationChain,
        address recipient
    ) public inboundTokenIsAllowed(_swap.sendingAssetId) {
        LibSwap.swap(0, _swap);
        uint256 availableNative = LibAsset.getOwnBalance(ZERO);
        gasZipRouter.deposit{ value: availableNative }(
            destinationChain,
            recipient
        );
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
        (bool success, ) = msg.sender.call{ value: address(this).balance }("");
        if (!success) revert TransferFailed();
    }
}
