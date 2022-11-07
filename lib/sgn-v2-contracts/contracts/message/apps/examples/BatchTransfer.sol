// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "../../framework/MessageApp.sol";

/** @title Sample app to test message passing flow, not for production use */
contract BatchTransfer is MessageApp {
    using SafeERC20 for IERC20;

    struct TransferRequest {
        uint64 nonce;
        address[] accounts;
        uint256[] amounts;
        address sender;
    }

    enum TransferStatus {
        Null,
        Success,
        Fail
    }

    struct TransferReceipt {
        uint64 nonce;
        TransferStatus status;
    }

    constructor(address _messageBus) MessageApp(_messageBus) {}

    // ============== functions and states on source chain ==============

    uint64 nonce;

    struct BatchTransferStatus {
        bytes32 h; // hash(receiver, dstChainId)
        TransferStatus status;
    }
    mapping(uint64 => BatchTransferStatus) public status; // nonce -> BatchTransferStatus

    modifier onlyEOA() {
        require(msg.sender == tx.origin, "Not EOA");
        _;
    }

    // called by sender on source chain to send tokens to a list of
    // <_accounts, _amounts> on the destination chain
    function batchTransfer(
        address _dstContract, // BatchTransfer contract address at the dst chain
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint32 _maxSlippage,
        MsgDataTypes.BridgeSendType _bridgeSendType,
        address[] calldata _accounts,
        uint256[] calldata _amounts
    ) external payable onlyEOA {
        uint256 totalAmt;
        for (uint256 i = 0; i < _amounts.length; i++) {
            totalAmt += _amounts[i];
        }
        // commented out the slippage check below to trigger failure case for handleFailedMessageWithTransfer testing
        // uint256 minRecv = _amount - (_amount * _maxSlippage) / 1e6;
        // require(minRecv > totalAmt, "invalid maxSlippage");
        nonce += 1;
        status[nonce] = BatchTransferStatus({
            h: keccak256(abi.encodePacked(_dstContract, _dstChainId)),
            status: TransferStatus.Null
        });
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        bytes memory message = abi.encode(
            TransferRequest({nonce: nonce, accounts: _accounts, amounts: _amounts, sender: msg.sender})
        );
        // send token and message to the destination chain
        sendMessageWithTransfer(
            _dstContract,
            _token,
            _amount,
            _dstChainId,
            nonce,
            _maxSlippage,
            message,
            _bridgeSendType,
            msg.value
        );
    }

    // called by MessageBus on source chain to handle message with token transfer failures (e.g., due to bad slippage).
    // the associated token transfer is guaranteed to have already been refunded
    function executeMessageWithTransferRefund(
        address _token,
        uint256 _amount,
        bytes calldata _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        TransferRequest memory transfer = abi.decode((_message), (TransferRequest));
        IERC20(_token).safeTransfer(transfer.sender, _amount);
        return ExecutionStatus.Success;
    }

    // called by MessageBus on source chain to receive receipts
    function executeMessage(
        address _sender,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        TransferReceipt memory receipt = abi.decode((_message), (TransferReceipt));
        require(status[receipt.nonce].h == keccak256(abi.encodePacked(_sender, _srcChainId)), "invalid message");
        status[receipt.nonce].status = receipt.status;
        return ExecutionStatus.Success;
    }

    // ============== functions on destination chain ==============

    // called by MessageBus on destination chain to handle batchTransfer message by
    // distributing tokens to receivers and sending receipt.
    // the lump sum token transfer associated with the message is guaranteed to have already been received.
    function executeMessageWithTransfer(
        address _srcContract,
        address _token,
        uint256 _amount,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        TransferRequest memory transfer = abi.decode((_message), (TransferRequest));
        uint256 totalAmt;
        for (uint256 i = 0; i < transfer.accounts.length; i++) {
            IERC20(_token).safeTransfer(transfer.accounts[i], transfer.amounts[i]);
            totalAmt += transfer.amounts[i];
        }
        uint256 remainder = _amount - totalAmt;
        if (_amount > totalAmt) {
            // transfer the remainder of the money to sender as fee for executing this transfer
            IERC20(_token).safeTransfer(transfer.sender, remainder);
        }
        bytes memory message = abi.encode(TransferReceipt({nonce: transfer.nonce, status: TransferStatus.Success}));
        // send receipt back to the source chain contract
        sendMessage(_srcContract, _srcChainId, message, msg.value);
        return ExecutionStatus.Success;
    }

    // called by MessageBus if handleMessageWithTransfer above got reverted
    function executeMessageWithTransferFallback(
        address _srcContract,
        address _token,
        uint256 _amount,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        TransferRequest memory transfer = abi.decode((_message), (TransferRequest));
        IERC20(_token).safeTransfer(transfer.sender, _amount);
        bytes memory message = abi.encode(TransferReceipt({nonce: transfer.nonce, status: TransferStatus.Fail}));
        // send receipt back to the source chain contract
        sendMessage(_srcContract, _srcChainId, message, msg.value);
        return ExecutionStatus.Success;
    }
}
