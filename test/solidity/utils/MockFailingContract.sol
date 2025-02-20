// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract MockFailingContract {
    fallback() external payable {
        revert("Always fails");
    }
}
