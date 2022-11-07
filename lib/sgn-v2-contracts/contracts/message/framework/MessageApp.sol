// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./MessageSenderApp.sol";
import "./MessageReceiverApp.sol";

abstract contract MessageApp is MessageSenderApp, MessageReceiverApp {
    constructor(address _messageBus) {
        messageBus = _messageBus;
    }
}
