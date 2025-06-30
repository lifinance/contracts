// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NothingToWithdraw();
error WithdrawFailed();

contract TestContractOne {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        (bool sent, ) = msg.sender.call{ value: amount }("");
        if (!sent) revert WithdrawFailed();
        balances[msg.sender] = 0;
    }
}
