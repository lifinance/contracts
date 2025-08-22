// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/LDA/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract XSwapV3FacetTest is BaseUniV3StyleDexFacetTest {
    // ==== Setup Functions ====
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({ networkName: "xdc", blockNumber: 89279495 });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.xswapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x2A8E898b6242355c290E1f4Fc966b8788729A4D4); // USDC.e
        tokenOut = IERC20(0x951857744785E80e2De051c32EE7b25f9c458C42); // WXDC
        poolInOut = 0x81B4afF811E94fb084A0d3B3ca456D09AeC14EB0; // pool
    }

    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }
}
