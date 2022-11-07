// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.0;

import "../../safeguard/Ownable.sol";

abstract contract MessageBusAddress is Ownable {
    event MessageBusUpdated(address messageBus);

    address public messageBus;

    function setMessageBus(address _messageBus) public virtual onlyOwner {
        messageBus = _messageBus;
        emit MessageBusUpdated(messageBus);
    }
}
