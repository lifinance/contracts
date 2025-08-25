// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseUniV2StyleDEXFacetTest } from "../BaseUniV2StyleDEXFacet.t.sol";

/// @title PancakeV2FacetTest
/// @notice Fork-based UniV2-style tests for PancakeV2 integration.
/// @dev Selects BSC fork, sets pool/token addresses, and delegates logic to base UniV2 test helpers.
contract PancakeV2FacetTest is BaseUniV2StyleDEXFacetTest {
    // ==== Setup Functions ====

    /// @notice Selects `bsc` network and block for fork tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({ networkName: "bsc", blockNumber: 58868609 });
    }

    /// @notice Resolves tokenIn/out and pool address for Pancake V2 BUSD/WBNB pair.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x55d398326f99059fF775485246999027B3197955); // BUSD
        tokenOut = IERC20(0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c); // WBNB
        poolInOut = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE; // Pancake V2 BUSD/WBNB pool
    }

    /// @notice Returns the pool fee for Pancake V2 BUSD/WBNB pair.
    /// @return fee The pool fee in basis points (e.g., 2500 for 0.25%)
    function _getPoolFee() internal pure override returns (uint24) {
        return 2500;
    }
}
