// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NotOwner();

contract ContractTestTwo {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function emergencyWithdrawForAdmin(
        address payable to,
        uint256 amount
    ) external {
        to.transfer(amount);
    }

    receive() external payable {}
}
