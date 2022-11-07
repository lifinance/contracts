// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "../../framework/MessageApp.sol";

// A HelloWorld example for basic cross-chain message passing
contract MsgExampleBasic is MessageApp {
    event MessageReceived(address srcContract, uint64 srcChainId, address sender, bytes message);

    constructor(address _messageBus) MessageApp(_messageBus) {}

    // called by user on source chain to send cross-chain messages
    function sendMessage(
        address _dstContract,
        uint64 _dstChainId,
        bytes calldata _message
    ) external payable {
        bytes memory message = abi.encode(msg.sender, _message);
        sendMessage(_dstContract, _dstChainId, message, msg.value);
    }

    // called by MessageBus on destination chain to receive cross-chain messages
    function executeMessage(
        address _srcContract,
        uint64 _srcChainId,
        bytes calldata _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        (address sender, bytes memory message) = abi.decode((_message), (address, bytes));
        emit MessageReceived(_srcContract, _srcChainId, sender, message);
        return ExecutionStatus.Success;
    }
}
