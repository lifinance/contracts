// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { ExternalCallFailed, UnAuthorized } from "../Errors/GenericErrors.sol";
import { Client } from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import { CCIPReceiver as CCIPRcvr } from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";

/// @title CCIPReceiver
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps
//  and message passing via Chainlink CCIP
/// @custom:version 2.0.2
contract CCIPReceiver is
    CCIPRcvr,
    ILiFi,
    ReentrancyGuard,
    TransferrableOwnership
{
    using SafeERC20 for IERC20;

    /// Storage ///
    IExecutor public executor;
    uint256 public recoverGas;

    /// Events ///
    event CCIPRouterSet(address indexed router);
    event ExecutorSet(address indexed executor);
    event RecoverGasSet(uint256 indexed recoverGas);

    constructor(
        address _owner,
        address _router,
        address _executor,
        uint256 _recoverGas
    ) TransferrableOwnership(_owner) CCIPRcvr(_router) {
        executor = IExecutor(_executor);
        recoverGas = _recoverGas;
        emit CCIPRouterSet(_router);
        emit ExecutorSet(_executor);
        emit RecoverGasSet(_recoverGas);
    }

    /// @notice Send remaining token to receiver
    /// @param assetId token received from the other chain
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
            IERC20(assetId).safeTransfer(receiver, amount);
        }
    }

    /// Internal Functions ///

    /// @notice Receive CCIP message and execute arbitrary calls
    /// @param message CCIP message
    function _ccipReceive(
        Client.Any2EVMMessage memory message
    ) internal override {
        // Extract swap data from message
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            ,
            address receiver
        ) = abi.decode(
                message.data,
                (bytes32, LibSwap.SwapData[], address, address)
            );
        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
            message.destTokenAmounts[0].token,
            payable(receiver),
            message.destTokenAmounts[0].amount
        );
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        if (LibAsset.isNativeAsset(assetId)) {
            // case 1: native asset
            uint256 cacheGasLeft = gasleft();
            if (cacheGasLeft < recoverGas) {
                // case 1a: not enough gas left to execute calls
                // solhint-disable-next-line avoid-low-level-calls
                (bool success, ) = receiver.call{ value: amount }("");
                if (!success) revert ExternalCallFailed();

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
                return;
            }

            // case 1b: enough gas left to execute calls
            // solhint-disable no-empty-blocks
            try
                executor.swapAndCompleteBridgeTokens{
                    value: amount,
                    gas: cacheGasLeft - recoverGas
                }(_transactionId, _swapData, assetId, receiver)
            {} catch {
                // solhint-disable-next-line avoid-low-level-calls
                (bool success, ) = receiver.call{ value: amount }("");
                if (!success) revert ExternalCallFailed();

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
            }
        } else {
            // case 2: ERC20 asset
            uint256 cacheGasLeft = gasleft();
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);

            if (cacheGasLeft < recoverGas) {
                // case 2a: not enough gas left to execute calls
                token.safeTransfer(receiver, amount);

                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
                return;
            }

            // case 2b: enough gas left to execute calls
            token.safeIncreaseAllowance(address(executor), amount);
            try
                executor.swapAndCompleteBridgeTokens{
                    gas: cacheGasLeft - recoverGas
                }(_transactionId, _swapData, assetId, receiver)
            {} catch {
                token.safeTransfer(receiver, amount);
                emit LiFiTransferRecovered(
                    _transactionId,
                    assetId,
                    receiver,
                    amount,
                    block.timestamp
                );
            }

            token.safeApprove(address(executor), 0);
        }
    }

    /// @notice Receive native asset directly.
    /// @dev Some bridges may send native asset before execute external calls.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
