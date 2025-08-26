// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UniV2StyleFacet } from "lifi/Periphery/LDA/Facets/UniV2StyleFacet.sol";
import { IUniV3StylePool } from "lifi/Interfaces/IUniV3StylePool.sol";
import { BaseDEXFacetTest } from "./BaseDEXFacet.t.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title BaseUniV2StyleDEXFacetTest
/// @notice Shared UniV2-style testing helpers built atop BaseDEXFacetTest.
/// @dev Handles selector wiring, pool direction inference (token0/token1), and auto-execution flows.
abstract contract BaseUniV2StyleDEXFacetTest is BaseDEXFacetTest {
    /// @notice UniV2-style facet proxy handle (points to diamond after setup).
    UniV2StyleFacet internal uniV2Facet;

    // ==== Types ====

    /// @notice Parameters for a single UniV2-style swap step.
    /// @param pool Target pool address.
    /// @param direction Direction of the swap (token0->token1 or vice versa).
    /// @param destinationAddress Destination address of the proceeds.
    struct UniV2SwapParams {
        address pool;
        SwapDirection direction;
        address destinationAddress;
        uint24 fee;
    }

    /// @notice Parameters for convenience auto-execution.
    /// @param commandType Whether to use aggregator funds or user funds.
    /// @param amountIn Input amount to test with.
    struct UniV2AutoSwapParams {
        CommandType commandType;
        uint256 amountIn;
    }

    // ==== Errors ====

    /// @notice Thrown when a pool does not include the provided token.
    /// @param token Token address not found in pool.
    /// @param pool Pool address.
    error TokenNotInPool(address token, address pool);

    // ==== Setup Functions ====

    /// @notice Deploys UniV2Style facet and registers `swapUniV2` + DEX-specific callback selector.
    /// @return facetAddress Address of the deployed facet implementation.
    /// @return functionSelectors Selectors for swap and callback.
    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        uniV2Facet = new UniV2StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV2Facet.swapUniV2.selector;
        return (address(uniV2Facet), functionSelectors);
    }

    /// @notice Sets `uniV2Facet` to the diamond proxy (post-cut).
    /// @param facetAddress Diamond proxy address.
    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        uniV2Facet = UniV2StyleFacet(facetAddress);
    }

    // ==== Helper Functions ====

    /// @notice Virtual function to get the pool fee. Child contracts should override this.
    /// @return fee The pool fee in basis points (e.g., 3000 for 0.3%)
    function _getPoolFee() internal virtual returns (uint24);

    /// @notice Builds packed swap data for UniV2-style swap dispatch.
    /// @param params Struct including pool, direction and destinationAddress.
    /// @return Packed payload starting with `swapUniV2` selector.
    function _buildUniV2SwapData(
        UniV2SwapParams memory params
    ) internal returns (bytes memory) {
        return
            abi.encodePacked(
                uniV2Facet.swapUniV2.selector,
                params.pool,
                uint8(params.direction),
                params.destinationAddress,
                params.fee
            );
    }

    /// @notice Executes a UniV2-style swap for arbitrary pool and direction.
    /// @param params Swap test params (sender/destinationAddress/funding mode).
    /// @param pool Pool to swap on.
    /// @param direction Swap direction to use.
    /// @dev Funds sender or diamond accordingly, builds route and executes with default assertions.
    function _executeUniV2StyleSwap(
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

        bytes memory swapData = _buildUniV2SwapData(
            UniV2SwapParams({
                pool: pool,
                direction: direction,
                destinationAddress: params.destinationAddress,
                fee: _getPoolFee()
            })
        );

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        vm.stopPrank();
    }

    /// @notice Infers direction (token0->token1 or token1->token0) given a pool and `tokenIn`.
    /// @param pool The target UniV2-style pool.
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
    function _executeUniV2StyleSwapAuto(
        UniV2AutoSwapParams memory params
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
        bytes memory swapData = _buildUniV2SwapData(
            UniV2SwapParams({
                pool: poolInOut,
                direction: direction,
                destinationAddress: USER_SENDER,
                fee: _getPoolFee() // Replace params.fee with dynamic fee
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
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: params.commandType
            }),
            route
        );

        vm.stopPrank();
    }

    // ==== Test Cases ====

    /// @notice Tests that the facet reverts when pool address is zero
    function testRevert_InvalidPool() public {
        vm.startPrank(USER_SENDER);

        bytes memory swapDataZeroPool = _buildUniV2SwapData(
            UniV2SwapParams({
                pool: address(0),
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_SENDER,
                fee: 3000 // 0.3% standard fee
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapDataZeroPool,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Tests that the facet reverts when destination address is zero
    function testRevert_InvalidDestinationAddress() public {
        vm.startPrank(USER_SENDER);

        bytes memory swapDataZeroDestination = _buildUniV2SwapData(
            UniV2SwapParams({
                pool: poolInOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: address(0),
                fee: 3000
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapDataZeroDestination,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Tests that the facet reverts when fee is invalid (>= FEE_DENOMINATOR)
    function testRevert_InvalidFee() public {
        vm.startPrank(USER_SENDER);

        bytes memory swapDataInvalidFee = _buildUniV2SwapData(
            UniV2SwapParams({
                pool: poolInOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_SENDER,
                fee: 1_000_000 // Equal to FEE_DENOMINATOR
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapDataInvalidFee,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Intentionally skipped: UniV2 multi-hop unsupported due to amountSpecified=0 limitation on second hop.
    function test_CanSwap_MultiHop() public virtual override {
        // SKIPPED: UniV2 forke dex multi-hop unsupported due to AS (amount specified) requirement.
        // UniV2 forke dex does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV2-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two uniV2 pools
        // in a single processRoute invocation.
    }

    /// @notice Empty test as UniV2-style dexes does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_CallbackFromUnexpectedSender() public override {
        // UniV2-style dexes does not use callbacks - test intentionally empty
    }

    /// @notice Empty test as UniV2-style dexes does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_SwapWithoutCallback() public override {
        // UniV2-style dexes does not use callbacks - test intentionally empty
    }

    /// @notice User-funded single-hop swap on UniV2-style pool inferred from `poolInOut`.
    function test_CanSwap() public virtual override {
        _executeUniV2StyleSwapAuto(
            UniV2AutoSwapParams({
                commandType: CommandType.ProcessUserERC20,
                amountIn: _getDefaultAmountForTokenIn()
            })
        );
    }

    /// @notice Aggregator-funded single-hop swap on UniV2-style.
    function test_CanSwap_FromDexAggregator() public virtual override {
        _executeUniV2StyleSwapAuto(
            UniV2AutoSwapParams({
                commandType: CommandType.ProcessMyERC20,
                amountIn: _getDefaultAmountForTokenIn() - 1
            })
        );
    }
}
