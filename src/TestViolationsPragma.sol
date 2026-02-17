// SPDX-License-Identifier: LGPL-3.0-only

// VIOLATION: Blank line between SPDX and pragma (should be no blank line)
// VIOLATION: Wrong pragma version (should be ^0.8.17, not ^0.8.20)
pragma solidity ^0.8.20;

// VIOLATION: Missing NatSpec header (@title, @author, @notice, @custom:version)
// This contract violates license/pragma conventions for testing CodeRabbit detection
contract TestViolationsPragma {
    // VIOLATION: Missing NatSpec for public function
    function testFunction() public pure returns (uint256) {
        return 42;
    }
}
