// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseDexFacetTest } from "./BaseDexFacet.t.sol";

abstract contract BaseUniV3StyleDexFacetTest is BaseDexFacetTest {
    UniV3StyleFacet internal uniV3Facet;

    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        uniV3Facet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3Facet.swapUniV3.selector;
        functionSelectors[1] = _getCallbackSelector(); // Each implementation provides its specific callback
        return (address(uniV3Facet), functionSelectors);
    }

    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        uniV3Facet = UniV3StyleFacet(facetAddress);
    }

    // Each UniV3-style DEX must implement this to provide its specific callback selector
    function _getCallbackSelector() internal virtual returns (bytes4);

    function test_CanSwap_MultiHop() public virtual override {
        // SKIPPED: UniV3 forke dex multi-hop unsupported due to AS (amount specified) requirement.
        // UniV3 forke dex does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two uniV3 pools
        // in a single processRoute invocation.
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

    function _executeUniV3StyleSwap(
        SwapTestParams memory params,
        address pool,
        SwapDirection direction
    ) internal {
        // Fund the appropriate account
        if (params.commandType == CommandType.ProcessMyERC20) {
            // if tokens come from the aggregator (address(ldaDiamond)), use command code 1; otherwise, use 2.
            deal(params.tokenIn, address(ldaDiamond), params.amountIn + 1);
        } else {
            deal(params.tokenIn, params.sender, params.amountIn);
        }

        vm.startPrank(params.sender);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: pool,
                direction: direction,
                recipient: params.recipient
            })
        );

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        vm.stopPrank();
    }
}
