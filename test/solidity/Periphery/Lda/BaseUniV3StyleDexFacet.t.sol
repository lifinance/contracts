// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseDexFacetWithCallbackTest } from "./BaseDEXFacetWithCallback.t.sol";

/// @title BaseUniV3StyleDexFacetTest
/// @notice Shared UniV3-style testing helpers built atop BaseDexFacetWithCallbackTest.
/// @dev Handles selector wiring, pool direction inference (token0/token1), and auto-execution flows.
abstract contract BaseUniV3StyleDexFacetTest is BaseDexFacetWithCallbackTest {
    /// @notice UniV3-style facet proxy handle (points to diamond after setup).
    UniV3StyleFacet internal uniV3Facet;

    // ==== Types ====

    /// @notice Parameters for a single UniV3-style swap step.
    /// @param pool Target pool address.
    /// @param direction Direction of the swap (token0->token1 or vice versa).
    /// @param destinationAddress Destination address of the proceeds.
    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address destinationAddress;
    }

    /// @notice Parameters for convenience auto-execution.
    /// @param commandType Whether to use aggregator funds or user funds.
    /// @param amountIn Input amount to test with.
    struct UniV3AutoSwapParams {
        CommandType commandType;
        uint256 amountIn;
    }

    // ==== Errors ====

    /// @notice Thrown when a pool does not include the provided token.
    /// @param token Token address not found in pool.
    /// @param pool Pool address.
    error TokenNotInPool(address token, address pool);

    // ==== Setup Functions ====

    /// @notice Deploys UniV3Style facet and registers `swapUniV3` + DEX-specific callback selector.
    /// @return facetAddress Address of the deployed facet implementation.
    /// @return functionSelectors Selectors for swap and callback.
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

    /// @notice Sets `uniV3Facet` to the diamond proxy (post-cut).
    /// @param ldaDiamond Diamond proxy address.
    function _setFacetInstance(address payable ldaDiamond) internal override {
        uniV3Facet = UniV3StyleFacet(ldaDiamond);
    }

    // ==== Helper Functions ====

    /// @notice Builds packed swap data for UniV3-style swap dispatch.
    /// @param params Struct including pool, direction and destinationAddress.
    /// @return Packed payload starting with `swapUniV3` selector.
    function _buildUniV3SwapData(
        UniV3SwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                uniV3Facet.swapUniV3.selector,
                params.pool,
                uint8(params.direction),
                params.destinationAddress
            );
    }

    /// @notice Executes a UniV3-style swap for arbitrary pool and direction.
    /// @param params Swap test params (sender/destinationAddress/funding mode).
    /// @param pool Pool to swap on.
    /// @param direction Swap direction to use.
    /// @dev Funds sender or diamond accordingly, builds route and executes with default assertions.
    function _executeUniV3StyleSwap(
        SwapTestParams memory params,
        address pool,
        SwapDirection direction
    ) internal {
        // Fund the appropriate account
        if (params.commandType == CommandType.DistributeSelfERC20) {
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
                destinationAddress: params.destinationAddress
            })
        );

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        vm.stopPrank();
    }

    /// @notice Infers direction (token0->token1 or token1->token0) given a pool and `tokenIn`.
    /// @param pool The target UniV3-style pool.
    /// @param tokenIn The input token address.
    /// @return Inferred direction.
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

    /// @notice Convenience flow: infers direction from `poolInOut` and executes with given funding mode.
    /// @param params commandType + amountIn
    /// @dev Funds sender or diamond, builds route for `poolInOut`, and executes.
    function _executeUniV3StyleSwapAuto(
        UniV3AutoSwapParams memory params
    ) internal {
        uint256 amountIn = params.amountIn;

        // Fund the appropriate account
        if (params.commandType == CommandType.DistributeSelfERC20) {
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
                destinationAddress: USER_SENDER
            })
        );

        // Build route and execute
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: params.commandType == CommandType.DistributeSelfERC20
                    ? address(ldaDiamond)
                    : USER_SENDER,
                destinationAddress: USER_SENDER,
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
                sender: params.commandType == CommandType.DistributeSelfERC20
                    ? address(ldaDiamond)
                    : USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: params.commandType
            }),
            route
        );

        vm.stopPrank();
    }

    // ==== Overrides ====

    /// @notice Builds callback-arming swap data for `BaseDexFacetWithCallbackTest` harness.
    /// @param pool Pool to invoke against in callback tests.
    /// @param destinationAddress Destination address for proceeds in these tests.
    /// @return Packed swap payload.
    function _buildCallbackSwapData(
        address pool,
        address destinationAddress
    ) internal view override returns (bytes memory) {
        return
            _buildUniV3SwapData(
                UniV3SwapParams({
                    pool: pool,
                    direction: SwapDirection.Token0ToToken1,
                    destinationAddress: destinationAddress
                })
            );
    }

    // ==== Test Cases ====

    /// @notice Intentionally skipped: UniV3 multi-hop unsupported due to amountSpecified=0 limitation on second hop.
    function test_CanSwap_MultiHop() public virtual override {
        // SKIPPED: UniV3 forke dex multi-hop unsupported due to AS (amount specified) requirement.
        // UniV3 forke dex does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two uniV3 pools
        // in a single processRoute invocation.
    }

    /// @notice User-funded single-hop swap on UniV3-style pool inferred from `poolInOut`.
    function test_CanSwap() public virtual override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.DistributeUserERC20,
                amountIn: _getDefaultAmountForTokenIn()
            })
        );
    }

    /// @notice Aggregator-funded single-hop swap on UniV3-style.
    function test_CanSwap_FromDexAggregator() public virtual override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.DistributeSelfERC20,
                amountIn: _getDefaultAmountForTokenIn()
            })
        );
    }

    /// @notice Tests that swaps with amountIn > type(int256).max revert
    function testBase_Revert_SwapUniV3WithAmountOverInt256Max() public {
        uint256 amountIn = uint256(type(int256).max) + 10;

        // Fund the sender
        deal(address(tokenIn), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        SwapDirection direction = _getDirection(poolInOut, address(tokenIn));
        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: poolInOut,
                direction: direction,
                destinationAddress: USER_SENDER
            })
        );

        // Build route and execute with expected revert
        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }
}
