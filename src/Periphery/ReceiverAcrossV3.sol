// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ExternalCallFailed, UnAuthorized } from "../Errors/GenericErrors.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/// @title ReceiverAcrossV3
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing via AcrossV3
/// @custom:version 1.0.0
contract ReceiverAcrossV3 is ILiFi, TransferrableOwnership {
    using SafeTransferLib for address;

    /// Error ///
    error InsufficientGasLimit(uint256 gasLeft);

    /// Storage ///
    IExecutor public immutable executor;
    address public immutable spokepool;
    uint256 public immutable recoverGas;

    /// Modifiers ///
    modifier onlySpokepool() {
        if (msg.sender != spokepool) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _executor,
        address _spokepool,
        uint256 _recoverGas
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        executor = IExecutor(_executor);
        spokepool = _spokepool;
        recoverGas = _recoverGas;
    }

    /// External Methods ///

    /// @notice Completes an AcrossV3 cross-chain transaction on the receiving chain
    /// @dev Token transfer and message execution will happen in one atomic transaction
    /// @dev This function can only be called the Across SpokePool on this network
    /// @param tokenSent The address of the token that was received
    /// @param amount The amount of tokens received
    /// @param * - unused(relayer) The address of the relayer who is executing this message
    /// @param message The composed message payload in bytes
    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address,
        bytes memory message
    ) external onlySpokepool {
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
            tokenSent,
            payable(receiver),
            amount
        );
    }

    /// @notice Send remaining token to receiver
    /// @param assetId address of the token to be withdrawn (not to be confused with StargateV2's assetIds which are uint16 values)
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function pullToken(
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
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId address of the token received from the source chain (not to be confused with StargateV2's assetIds which are uint16 values)
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        // since Across will always send wrappedNative to contract, we do not need a native handling here
        uint256 cacheGasLeft = gasleft();

        // We introduced this handling to prevent relayers from under-estimating our destination transactions and then
        // running into out-of-gas errors which would cause the bridged tokens to be refunded to the receiver. This is
        // an emergency behaviour but testing showed that this would happen very frequently.
        // Reverting transactions that dont have enough gas helps to make sure that transactions will get correctly estimated
        // by the relayers on source chain and thus improves the success rate of destination calls.
        if (cacheGasLeft < recoverGas) {
            // case A: not enough gas left to execute calls
            // @dev: we removed the handling to send bridged funds to receiver in case of insufficient gas
            //       as it's better for AcrossV3 to revert these cases instead
            revert InsufficientGasLimit(cacheGasLeft);
        }

        // case 2b: enough gas left to execute calls
        assetId.safeApprove(address(executor), 0);
        assetId.safeApprove(address(executor), amount);
        try
            executor.swapAndCompleteBridgeTokens{
                gas: cacheGasLeft - recoverGas
            }(_transactionId, _swapData, assetId, receiver)
        {} catch {
            cacheGasLeft = gasleft();
            // if the only gas left here is the recoverGas then the swap must have failed due to out-of-gas error and in this
            // case we want to revert (again, to force relayers to estimate our destination calls with sufficient gas limit)
            if (cacheGasLeft <= recoverGas)
                revert InsufficientGasLimit(cacheGasLeft);

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
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
