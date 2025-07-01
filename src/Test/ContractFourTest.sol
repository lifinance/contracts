// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ContractFourTest {
    event Executed(bool success, bytes data);

    function execute(address target, bytes calldata data) external payable {
        (bool success, bytes memory returnData) = target.call{
            value: msg.value
        }(data);
        emit Executed(success, returnData);
    }

    receive() external payable {}
}
