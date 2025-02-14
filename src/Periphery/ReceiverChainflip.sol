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
    using SafeTransferLib for address payable;

    /// Storage ///

    /// @notice The executor contract used for performing swaps
    IExecutor public immutable executor;
    /// @notice The Chainflip vault contract that is authorized to call this contract
    address public immutable chainflipVault;

    /// Modifiers ///

    /// @notice Ensures only the Chainflip vault can call the function
    /// @dev Reverts with UnAuthorized if called by any other address
    modifier onlyChainflipVault() {
        if (msg.sender != chainflipVault) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor ///

    /// @notice Initializes the contract with required addresses
    /// @param _owner Address that can withdraw funds from this contract
    /// @param _executor Address of the executor contract for performing swaps
    /// @param _chainflipVault Address of the Chainflip vault that can call this contract
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
    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId The transaction id associated with the operation
    /// @param _swapData Array of data needed for swaps
    /// @param assetId Address of the token received from the source chain
    /// @param receiver Address that will receive tokens in the end
    /// @param amount Amount of token to swap
    /// @dev If the swap fails, the original bridged tokens are sent directly to the receiver
    /// @dev Approvals are reset to 0 after the operation completes
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        // Don't need approval for native token
        if (assetId != LibAsset.NATIVE_ASSETID) {
            assetId.safeApproveWithRetry(address(executor), amount);
        }

        try
            executor.swapAndCompleteBridgeTokens{
                value: assetId == LibAsset.NATIVE_ASSETID ? amount : 0
            }(_transactionId, _swapData, assetId, receiver)
        {} catch {
            // send the bridged (and unswapped) funds to receiver address
            if (assetId == LibAsset.NATIVE_ASSETID) {
                // Handle native token using safeTransferETH
                receiver.safeTransferETH(amount);
            } else {
                // Handle ERC20 token
                assetId.safeTransfer(receiver, amount);
            }

            emit LiFiTransferRecovered(
                _transactionId,
                assetId,
                receiver,
                amount,
                block.timestamp
            );
        }

        // Only reset approval for non-native tokens
        if (assetId != LibAsset.NATIVE_ASSETID) {
            assetId.safeApprove(address(executor), 0);
        }
    }

    /// @notice Receive native asset directly.
    /// @notice Allows the contract to receive native assets directly
    /// @dev Required for receiving native token transfers
    receive() external payable {}
}
