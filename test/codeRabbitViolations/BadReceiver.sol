// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Receiver no hereda de ILiFi y WithdrawablePeriphery
contract BadReceiver {
    // Violación: executor no es immutable
    address public executor;
    
    // Violación: Constructor no valida address(0)
    constructor(address _executor) {
        executor = _executor;
    }
    
    // Violación: Emite LiFiTransferStarted (reservado para facets)
    function handleMessage(bytes memory data) external {
        emit LiFiTransferStarted(bytes32(0), address(0), address(0), 0, 0);
    }
    
    // Violación: Emite LiFiTransferCompleted (reservado para Executor)
    function complete() external {
        emit LiFiTransferCompleted(bytes32(0), address(0), address(0), 0);
    }
    
    // Violación: Falta receive() external payable {}
}
