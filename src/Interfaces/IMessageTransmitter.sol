// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMessageTransmitter {
    event MessageSent(bytes message);

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) external returns (uint64);

    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool success);
}