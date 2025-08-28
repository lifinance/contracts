// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDEXFacetTest } from "../BaseUniV3StyleDEXFacet.t.sol";

/// @title XSwapV3FacetTest
/// @notice XDC chain UniV3-style tests for XSwap V3 integration via LDA.
/// @dev Minimal setup; inherits execution logic from base UniV3-style test harness.
contract XSwapV3FacetTest is BaseUniV3StyleDEXFacetTest {
    // ==== Setup Functions ====

    /// @notice Selects XDC fork and block height used by the tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({ networkName: "xdc", blockNumber: 89279495 });
    }

    /// @notice Returns the XSwap V3 callback selector used during swaps.
    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.xswapCallback.selector;
    }

    /// @notice Sets tokenIn/out and the pool for XSwap V3 on XDC.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x2A8E898b6242355c290E1f4Fc966b8788729A4D4); // USDC.e
        tokenOut = IERC20(0x951857744785E80e2De051c32EE7b25f9c458C42); // WXDC
        poolInOut = 0x81B4afF811E94fb084A0d3B3ca456D09AeC14EB0; // pool
    }

    /// @notice Default input amount for USDC.e (6 decimals).
    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }
}
