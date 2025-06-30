// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NotOwner();

contract ContractTestTwo {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function emergencyWithdraw(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        to.transfer(amount);
    }

    receive() external payable {}
}
