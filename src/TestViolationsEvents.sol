// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// VIOLATION: Missing NatSpec header (@title, @author, @notice, @custom:version)
contract TestViolationsEvents {
    // VIOLATION: Event emitted using ContractName.EventName syntax (not allowed in 0.8.17)
    event SomeEvent(uint256 value);

    function emitEvent() public {
        // VIOLATION: This syntax is not allowed in Solidity 0.8.17
        // Should be: emit SomeEvent(123);
        emit TestViolationsEvents.SomeEvent(123);
    }
}

// VIOLATION: Missing NatSpec header
contract AnotherContract {
    event Transfer(address from, address to, uint256 amount);

    function transfer() public {
        // VIOLATION: ContractName.EventName syntax not allowed
        emit AnotherContract.Transfer(address(0x1), address(0x2), 100);
    }
}
