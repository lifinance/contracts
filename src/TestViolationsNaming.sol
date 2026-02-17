// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// VIOLATION: Missing NatSpec header (@title, @author, @notice, @custom:version)
contract TestViolationsNaming {
    // VIOLATION: Constant should be CONSTANT_CASE, not camelCase
    uint256 public constant testConstant = 100;

    // VIOLATION: Immutable should be CONSTANT_CASE, not camelCase
    address public immutable testImmutable = address(0x123);

    // VIOLATION: Function parameter missing leading underscore
    function testFunction(uint256 amount, address recipient) public {
        // Function body
    }

    // VIOLATION: Function parameter missing leading underscore
    function anotherFunction(string memory name) public pure returns (string memory) {
        return name;
    }
}

// VIOLATION: Interface name missing I* prefix (should be ITestInterface)
interface TestInterface {
    // VIOLATION: Missing NatSpec
    function someFunction() external;
}
