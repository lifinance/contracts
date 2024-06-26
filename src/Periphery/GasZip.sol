// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";

//TODO: REMOVE  <<<<<<<<<<<<<<<<<<<<<
import { console2 } from "forge-std/console2.sol";

interface IGasZip {
    function deposit(
        uint256 destinationChain,
        address recipient
    ) external payable;
}

/// @title GasZip
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality to swap and trigger gas.zip protocol
/// @custom:version 1.0.0
contract GasZip {
    using SafeTransferLib for address;

    /// State ///
    address public immutable ZERO = address(0);
    IGasZip public immutable gasZipRouter;

    /// Errors ///
    error TransferFailed();

    /// Events ///

    /// Constructor ///
    constructor(address _gasZipRouter) {
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    /// @notice Swaps ERC20 tokens to native and deposits these native tokens in the GasZip router contract
    /// @param _swapData The swap data struct
    /// @param _destinationChainId the id of the chain where gas should be made available
    /// @param _recipient the address to receive the gas on dst chain
    function zipERC20(
        LibSwap.SwapData calldata _swapData,
        uint256 _destinationChainId,
        address _recipient
    ) public {
        // pull tokens from caller (e.g. LI.FI diamond)
        _swapData.sendingAssetId.safeTransferFrom(
            msg.sender,
            address(this),
            _swapData.fromAmount
        );

        // execute the swapData that swaps the ERC20 token into native
        LibSwap.swap(0, _swapData);

        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: address(this).balance }(
            _destinationChainId,
            _recipient
        );

        // check remaining balance of sendingAsset
        uint256 remainingBalance = ERC20(_swapData.sendingAssetId).balanceOf(
            address(this)
        );

        // Send back any remaining sendingAsset tokens to the sender
        if (remainingBalance > 0) {
            _swapData.sendingAssetId.safeTransfer(
                msg.sender, //TODO: why send it back to msg.sender? That would mean that unused tokens are sent to the diamond. Should this be sent to _receiver instead?
                remainingBalance
            );
        }
    }

    /// @notice Deposits native tokens in the GasZip router contract and returns any unused
    /// @param _amountToZip The swap data struct
    /// @param _destinationChainId the id of the chain where gas should be made available
    /// @param _recipient the address to receive the gas on dst chain
    function zip(
        uint256 _amountToZip,
        uint256 _destinationChainId,
        address _recipient
    ) public payable {
        // call the gas zip router and deposit tokens
        gasZipRouter.deposit{ value: _amountToZip }(
            _destinationChainId,
            _recipient
        );

        // TODO: why do we need this? Costs unnecessary gas....is it not sufficient to just run the deposit?
        uint256 nativeBalance = address(this).balance;

        // Send back any remaining native balance to the sender
        //TODO: is this required for multi-swaps? Otherwise this should also be sent to _recipient instead I believe
        if (nativeBalance > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = msg.sender.call{ value: nativeBalance }("");
            if (!success) revert TransferFailed();
        }
    }

    receive() external payable {}
}
