// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseDexFacetTest } from "./BaseDexFacet.t.sol";

abstract contract BaseUniV3StyleDexFacetTest is BaseDexFacetTest {
    UniV3StyleFacet internal uniV3Facet;

    function test_CanSwap_MultiHop() public virtual override {
        // SKIPPED: UniV3 forke dex multi-hop unsupported due to AS (amount specified) requirement.
        // UniV3 forke dex does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two uniV3 pools
        // in a single processRoute invocation.
    }

    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    function _buildUniV3SwapData(
        UniV3SwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                uniV3Facet.swapUniV3.selector,
                params.pool,
                uint8(params.direction),
                params.recipient
            );
    }
}
