// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";

contract MockLiquidityBridge is TestBase {
    error NativeTokenTransferFailed();

    function mockWithdraw(uint256 _amount) external {
        (bool sent, ) = msg.sender.call{ value: _amount, gas: 50000 }("");
        if (!sent) {
            revert NativeTokenTransferFailed();
        }
    }
}
