// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap, InsufficientBalance } from "../Libraries/LibSwap.sol";
import { InvalidCaller, InsufficientBalance, NotAContract, ContractCallNotAllowed, ExternalCallFailed } from "../Errors/GenericErrors.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import { ExcessivelySafeCall } from "../Helpers/ExcessivelySafeCall.sol";

import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract RelayerCelerIM is ILiFi, ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;
    using LibBytes for bytes;
    using ExcessivelySafeCall for address;

    /// Storage ///
    address public cBridgeMessageBusAddress;
    IExecutor public executor;

    /// Errors ///
    error MessageExecutionFailed();

    /// Events ///
    event CBridgeMessageBusAddressSet(address indexed messageBusAddress);
    event LiFiRecovered(bytes32 transactionId, address indexed callTo, uint256 amount);

    /// Modifiers ///
    modifier onlyCBridgeMessageBus() {
        if (msg.sender != cBridgeMessageBusAddress) revert InvalidCaller();
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _cBridgeMessageBusAddress,
        address _executor
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        cBridgeMessageBusAddress = _cBridgeMessageBusAddress;
        executor = IExecutor(_executor);
        emit CBridgeMessageBusAddressSet(_cBridgeMessageBusAddress);
    }

    /// External Methods ///

    /**
     * @notice Called by MessageBus to execute a message with an associated token transfer.
     * The Receiver is guaranteed to have received the right amount of tokens before this function is called.
     * @param * (unused) The address of the source app contract
     * @param _token The address of the token that comes out of the bridge
     * @param _amount The amount of tokens received at this contract through the cross-chain bridge.
     * @param * (unused)  The source chain ID where the transfer is originated from
     * @param _message Arbitrary message bytes originated from and encoded by the source app contract
     * @param * (unused)  Address who called the MessageBus execution function
     */
    function executeMessageWithTransfer(
        address,
        address _token,
        uint256 _amount,
        uint64,
        bytes calldata _message,
        address
    ) external payable returns (IMessageReceiverApp.ExecutionStatus) {
        // decode message
        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, address receiver, address refundAddress) = abi
            .decode(_message, (bytes32, LibSwap.SwapData[], address, address));

        _swapAndCompleteBridgeTokens(transactionId, swapData, _token, payable(receiver), _amount, refundAddress);

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    /**
     * @notice Called by MessageBus to process refund of the original transfer from this contract.
     * The contract is guaranteed to have received the refund before this function is called.
     * @param _token The token address of the original transfer
     * @param _amount The amount of the original transfer
     * @param _message The same message associated with the original transfer
     * @param * (unused) Address who called the MessageBus execution function
     */
    function executeMessageWithTransferRefund(
        address _token,
        uint256 _amount,
        bytes calldata _message,
        address
    ) external payable onlyCBridgeMessageBus returns (IMessageReceiverApp.ExecutionStatus) {
        (bytes32 transactionId, , , address refundAddress) = abi.decode(
            _message,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        // return funds to cBridgeData.refundAddress
        LibAsset.transferAsset(_token, payable(refundAddress), _amount);

        emit LiFiTransferRecovered(transactionId, _token, refundAddress, _amount, block.timestamp);

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    /// @notice sets the CBridge MessageBus address
    /// @param _messageBusAddress the MessageBus address
    function setCBridgeMessageBus(address _messageBusAddress) external onlyOwner {
        cBridgeMessageBusAddress = _messageBusAddress;
        emit CBridgeMessageBusAddressSet(_messageBusAddress);
    }

    // ------------------------------------------------------------------------------------------------

    /// Private Methods ///

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
        uint256 amount,
        address refundAddress
    ) private {
        bool success;
        if (LibAsset.isNativeAsset(assetId)) {
            try executor.swapAndCompleteBridgeTokens{ value: amount }(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                (bool fundsSent, ) = refundAddress.call{ value: amount }("");
                if (!fundsSent) revert ExternalCallFailed();
            }
        } else {
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);
            token.safeIncreaseAllowance(address(executor), amount);

            try executor.swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                token.safeTransfer(refundAddress, amount);
            }
            token.safeApprove(address(executor), 0);
        }

        if (!success) {
            emit LiFiTransferRecovered(_transactionId, assetId, refundAddress, amount, block.timestamp);
        }
    }

    triggergr
}
