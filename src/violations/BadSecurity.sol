// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Does not validate external inputs
// Violation: Governance bypass - direct admin function without timelock/safe/timelock controller
contract BadSecurityContract {
    address public owner;
    
    // Violation: Admin function that bypasses timelock/Safe governance
    function emergencyUpgrade(address newContract) public {
        require(msg.sender == owner, "Not owner");
        // Direct upgrade without going through governance / Safe / timelock
    }
    
    // Violation: Does not validate parameters
    function setConfig(uint256 value, address target) public {
        // Missing checks for address(0) or invalid values
        // Does not use existing validation helpers (e.g. Validatable / library helpers)
    }
}
