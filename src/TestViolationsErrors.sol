// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// VIOLATION: Missing NatSpec header (@title, @author, @notice, @custom:version)
contract TestViolationsErrors {
    // VIOLATION: Using revert string instead of custom error
    function testRevert(uint256 amount) public pure {
        require(amount > 0, "Amount must be greater than zero");
    }

    // VIOLATION: Using revert string instead of custom error
    function testAnotherRevert(address addr) public pure {
        require(addr != address(0), "Address cannot be zero");
    }

    // VIOLATION: Using revert string instead of custom error
    function testRevertWithMessage() public pure {
        revert("This is a revert string, should use custom error");
    }
}
