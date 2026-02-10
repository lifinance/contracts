// Violation: Missing SPDX license, wrong pragma, and blank line between SPDX and pragma
pragma solidity ^0.8.17;

// Violation: Incomplete NatSpec - missing @title, @author, @notice, @custom:version
contract BadSolidityContract {
    // Violation: Naming - constant should be CONSTANT_CASE
    uint256 public constant maxAmount = 1000;
    
    // Violation: Naming - parameter is missing leading underscore
    function transfer(uint256 amount) public {
        // Violation: Blank lines - missing blank line between logical sections
        uint256 balance = 100;
        emit Transfer(amount);
    }
    
    // Violation: Event - uses ContractName.EventName syntax (not allowed in 0.8.17)
    event BadSolidityContract.Transfer(uint256 amount);
}
