// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";

/// @title MockNoCallbackPool
/// @author LI.FI (https://li.fi)
/// @notice Mock pool that doesn't call back
/// @custom:version 1.0.0
contract MockNoCallbackPool is IUniV3StylePool {
    function token0() external pure returns (address) {
        return address(1);
    }

    function token1() external pure returns (address) {
        return address(2);
    }

    function swap(
        address,
        bool,
        int256,
        uint160,
        bytes calldata
    ) external pure returns (int256, int256) {
        // Do nothing - don't call the callback
        return (0, 0);
    }
}
