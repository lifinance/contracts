// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract MockFailingContract {
    error AlwaysFails();

    fallback() external payable {
        revert AlwaysFails();
    }
}
