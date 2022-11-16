// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap, InsufficientBalance } from "../Libraries/LibSwap.sol";
import { InvalidCaller, InsufficientBalance, NotAContract, ContractCallNotAllowed } from "../Errors/GenericErrors.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import { ExcessivelySafeCall } from "../Helpers/ExcessivelySafeCall.sol";

//tmp
import { console } from "../../test/solidity/utils/Console.sol"; //TODO: remove
import { DSTest } from "ds-test/test.sol"; //TODO: remove

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract ReceiverCelerIM is DSTest, ILiFi, ReentrancyGuard, TransferrableOwnership {
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
    event CelerIMMessageExecuted(address indexed callTo, bytes4 selector);
    event CelerIMMessageWithTransferExecuted(bytes32 indexed transactionId, address indexed receiver);
    event CelerIMMessageWithTransferFailed(
        bytes32 indexed transactionId,
        address indexed receiver,
        address indexed refundAddress
    );

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
     * @notice Called by MessageBus to execute a message
     * @param _sender The address of the source app contract
     * @param _srcChainId The source chain ID where the transfer is originated from
     * @param _message Arbitrary message bytes originated from and encoded by the source app contract
     * @param _executor Address who called the MessageBus execution function
     */
    function executeMessage(
        address _sender,
        uint64 _srcChainId,
        bytes calldata _message,
        address _executor
    ) external payable returns (IMessageReceiverApp.ExecutionStatus) {
        return _executeMessage(_sender, _srcChainId, _message, _executor);
    }

    // same as above, except that sender is an non-evm chain address,
    // otherwise same as above.
    function executeMessage(
        bytes calldata _sender,
        uint64 _srcChainId,
        bytes calldata _message,
        address _executor
    ) external payable returns (IMessageReceiverApp.ExecutionStatus) {
        address sender = _bytesToAddress(_sender); //TODO QUESTION: is this OK?
        return _executeMessage(sender, _srcChainId, _message, _executor);
    }

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
        //! will this revert if data does not match the structure? >> NO
        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, address receiver, address refundAddress) = abi
            .decode(_message, (bytes32, LibSwap.SwapData[], address, address));

        //TODO QUESTION: should we and how to validate if data was correctly coded and decoded?

        _swapAndCompleteBridgeTokens(transactionId, swapData, _token, payable(receiver), _amount);

        emit CelerIMMessageWithTransferExecuted(transactionId, receiver);

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    /**
     * @notice Only called by MessageBus if
     *         1. executeMessageWithTransfer reverts, or
     *         2. executeMessageWithTransfer returns IMessageReceiverApp.ExecutionStatus.Fail
     * The contract is guaranteed to have received the right amount of tokens before this function is called.
     * @param * (unused) The address of the source app contract
     * @param _token The address of the token that comes out of the bridge
     * @param _amount The amount of tokens received at this contract through the cross-chain bridge.
     * @param * (unused) The source chain ID where the transfer is originated from
     * @param _message Arbitrary message bytes originated from and encoded by the source app contract
     * @param * (unused) Address who called the MessageBus execution function
     */
    function executeMessageWithTransferFallback(
        address,
        address _token,
        uint256 _amount,
        uint64,
        bytes calldata _message,
        address
    ) external payable returns (IMessageReceiverApp.ExecutionStatus) {
        (bytes32 transactionId, , address receiver, address refundAddress) = abi.decode(
            _message,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        // transfer tokens back to refundAddress
        LibAsset.transferAsset(_token, payable(refundAddress), _amount);

        emit CelerIMMessageWithTransferFailed(transactionId, receiver, refundAddress);

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
        uint256 amount
    ) private {
        bool success;
        if (LibAsset.isNativeAsset(assetId)) {
            try executor.swapAndCompleteBridgeTokens{ value: amount }(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                //? removed the following to not break CBridge refund flow. pls confirmÙ
                // receiver.call{ value: amount }("");
                revert("DB: Call to Executor not successful"); //TODO remove
            }
        } else {
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);
            token.safeIncreaseAllowance(address(executor), amount);

            try executor.swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                // token.safeTransfer(receiver, amount);
                //? removed the following to not break CBridge refund flow. pls confirmÙ
                revert("DB: Call to Executor not successful"); //TODO remove
            }
            token.safeApprove(address(executor), 0);
        }

        if (!success) {
            emit LiFiTransferCompleted(_transactionId, assetId, receiver, amount, block.timestamp);
        }
    }

    function _executeMessage(
        address _sender,
        uint64 _srcChainId,
        bytes calldata _message,
        address _executor
    ) private returns (IMessageReceiverApp.ExecutionStatus) {
        emit log_string("_executeMessage");
        emit log_named_bytes("message", _message);
        ("_executeMessage");
        // decode message
        // The first 20 bytes of the _message are the callee address
        address callTo = _message.toAddress(0);
        // The remaining bytes should be calldata
        bytes memory callData = _message.slice(40, _message.length - 40);

        if (!LibAsset.isContract(callTo)) revert NotAContract();

        //TODO any other checks to do here?
        if (LibAllowList.contractIsAllowed(callTo)) revert ContractCallNotAllowed();

        //! this call fails, I dont know why
        (bool success, ) = callTo.excessivelySafeCall(gasleft(), 0, 0, callData);
        if (!success) {
            revert MessageExecutionFailed();
        }

        // first 4 bytes of callData should be the function selector
        emit CelerIMMessageExecuted(callTo, bytes4(callData));

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    function _bytesToAddress(bytes memory b) private pure returns (address payable a) {
        require(b.length == 20);
        assembly {
            a := div(mload(add(b, 32)), exp(256, 12))
        }
    }
}
