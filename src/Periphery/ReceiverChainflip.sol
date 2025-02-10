// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/// @title ReceiverChainflip
/// @author LI.FI (https://li.fi)
/// @notice Receiver contract for Chainflip cross-chain swaps and message passing
/// @custom:version 1.0.0
contract ReceiverChainflip is ILiFi, WithdrawablePeriphery {
    using SafeTransferLib for address;

    /// Storage ///
    IExecutor public immutable executor;
    address public immutable chainflipVault;

    /// Modifiers ///
    modifier onlyChainflipVault() {
        if (msg.sender != chainflipVault) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _executor,
        address _chainflipVault
    ) WithdrawablePeriphery(_owner) {
        executor = IExecutor(_executor);
        chainflipVault = _chainflipVault;
    }

    /// External Methods ///

    /// @notice Receiver function for Chainflip cross-chain messages
    /// @dev This function can only be called by the Chainflip Vault on this network
    /// @dev First param (unused): The source chain according to Chainflip's nomenclature
    /// @dev Second param (unused): The source address on the source chain
    /// @param message The message sent from the source chain
    /// @param token The address of the token received
    /// @param amount The amount of tokens received
    function cfReceive(
        uint32, // srcChain
        bytes calldata, // srcAddress
        bytes calldata message,
        address token,
        uint256 amount
    ) external payable onlyChainflipVault {
        // decode payload
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            address receiver
        ) = abi.decode(message, (bytes32, LibSwap.SwapData[], address));

        // execute swap(s)
        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
            token,
            payable(receiver),
            amount
        );
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId address of the token received from the source chain
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        assetId.safeApproveWithRetry(address(executor), amount);
        try
            executor.swapAndCompleteBridgeTokens(
                _transactionId,
                _swapData,
                assetId,
                receiver
            )
        {} catch {
            // send the bridged (and unswapped) funds to receiver address
            assetId.safeTransfer(receiver, amount);

            emit LiFiTransferRecovered(
                _transactionId,
                assetId,
                receiver,
                amount,
                block.timestamp
            );
        }

        // reset approval to 0
        assetId.safeApprove(address(executor), 0);
    }

    /// @notice Receive native asset directly.
    receive() external payable {}
}
