// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

contract MockFailingContract {
    error AlwaysFails();

    fallback() external payable {
        revert AlwaysFails();
    }
}
