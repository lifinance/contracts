// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";
import { BaseDexFacetWithCallbackTest } from "./BaseDexFacetWithCallback.t.sol";

abstract contract BaseUniV3StyleDexFacetTest is BaseDexFacetWithCallbackTest {
    UniV3StyleFacet internal uniV3Facet;

    // ==== Types ====
    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    struct UniV3AutoSwapParams {
        CommandType commandType;
        uint256 amountIn;
    }

    // ==== Errors ====
    error TokenNotInPool(address token, address pool);

    // ==== Setup Functions ====
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

    // ==== Helper Functions ====
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

    // Infer swap direction from pool's token0/token1 and TOKEN_IN
    function _getDirection(
        address pool,
        address tokenIn
    ) internal view returns (SwapDirection) {
        address t0 = IUniV3StylePool(pool).token0();
        address t1 = IUniV3StylePool(pool).token1();
        if (tokenIn == t0) return SwapDirection.Token0ToToken1;
        if (tokenIn == t1) return SwapDirection.Token1ToToken0;
        revert TokenNotInPool(tokenIn, pool);
    }

    function _executeUniV3StyleSwapAuto(
        UniV3AutoSwapParams memory params
    ) internal {
        uint256 amountIn = params.commandType == CommandType.ProcessMyERC20
            ? params.amountIn + 1
            : params.amountIn;

        // Fund the appropriate account
        if (params.commandType == CommandType.ProcessMyERC20) {
            deal(address(tokenIn), address(ldaDiamond), amountIn + 1);
        } else {
            deal(address(tokenIn), USER_SENDER, amountIn);
        }

        vm.startPrank(USER_SENDER);

        SwapDirection direction = _getDirection(poolInOut, address(tokenIn));
        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: poolInOut,
                direction: direction,
                recipient: USER_SENDER
            })
        );

        // Build route and execute
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: params.commandType
            }),
            swapData
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: params.commandType
            }),
            route
        );

        vm.stopPrank();
    }

    // ==== Overrides ====
    function _buildCallbackSwapData(
        address pool,
        address recipient
    ) internal view override returns (bytes memory) {
        return
            _buildUniV3SwapData(
                UniV3SwapParams({
                    pool: pool,
                    direction: SwapDirection.Token0ToToken1,
                    recipient: recipient
                })
            );
    }

    // ==== Test Cases ====
    function test_CanSwap_MultiHop() public virtual override {
        // SKIPPED: UniV3 forke dex multi-hop unsupported due to AS (amount specified) requirement.
        // UniV3 forke dex does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two uniV3 pools
        // in a single processRoute invocation.
    }

    function test_CanSwap() public virtual override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.ProcessUserERC20,
                amountIn: _getDefaultAmountForTokenIn()
            })
        );
    }

    function test_CanSwap_FromDexAggregator() public virtual override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.ProcessMyERC20,
                amountIn: _getDefaultAmountForTokenIn() - 1
            })
        );
    }
}
