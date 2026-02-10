// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Receiver does not inherit from ILiFi and WithdrawablePeriphery
contract BadReceiver {
    // Violation: executor is not immutable
    address public executor;
    
    // Violation: constructor does not validate address(0)
    constructor(address _executor) {
        executor = _executor;
    }
    
    // Violation: emits LiFiTransferStarted (should only be emitted in bridge facets)
    function handleMessage(bytes memory data) external {
        emit LiFiTransferStarted(bytes32(0), address(0), address(0), 0, 0);
    }
    
    // Violation: emits LiFiTransferCompleted (should only be emitted in Executor)
    function complete() external {
        emit LiFiTransferCompleted(bytes32(0), address(0), address(0), 0);
    }
    
    // Violation: missing receive() external payable {}
}
