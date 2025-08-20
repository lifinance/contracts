// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";

/// @title MockNoCallbackPool
/// @author LI.FI (https://li.fi)
/// @notice Mock pool that simulates successful swaps without executing callbacks
/// @dev Used to test callback verification in facets. This mock:
///      1. Implements UniV3-style interface for base compatibility
///      2. Returns dummy token addresses for token0/token1
///      3. Returns (0,0) for all swap calls without executing callbacks
///      4. Catches all non-standard swap calls (like Izumi's swapX2Y) via fallback
/// @custom:version 1.0.0
contract MockNoCallbackPool is IUniV3StylePool {
    /// @notice Returns a dummy token0 address
    function token0() external pure returns (address) {
        return address(1);
    }

    /// @notice Returns a dummy token1 address
    function token1() external pure returns (address) {
        return address(2);
    }

    /// @notice UniV3-style swap that doesn't execute callbacks
    /// @dev Always returns (0,0) to simulate successful swap without callback
    function swap(
        address,
        bool,
        int256,
        uint160,
        bytes calldata
    ) external pure returns (int256, int256) {
        // Simulate successful swap without executing callback
        return (0, 0);
    }

    /// @notice Catch-all for non-standard swap functions (Izumi, Algebra, etc)
    /// @dev Returns (0,0) encoded as bytes to match return types of various swap functions
    fallback() external {
        assembly {
            mstore(0x00, 0)
            mstore(0x20, 0)
            return(0x00, 0x40) // Return (0,0) for any swap function
        }
    }

    /// @notice Required to receive ETH from swaps if needed
    receive() external payable {}
}
