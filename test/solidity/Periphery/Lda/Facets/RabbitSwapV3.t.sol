// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract RabbitSwapV3FacetTest is BaseUniV3StyleDexFacetTest {
    // Constants for RabbitSwap on Viction
    IERC20 internal constant SOROS =
        IERC20(0xB786D9c8120D311b948cF1e5Aa48D8fBacf477E2);
    IERC20 internal constant C98 =
        IERC20(0x0Fd0288AAAE91eaF935e2eC14b23486f86516c8C);
    address internal constant SOROS_C98_POOL =
        0xF10eFaE2DdAC396c4ef3c52009dB429A120d0C0D;

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_VICTION",
            blockNumber: 94490946
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.rabbitSwapV3SwapCallback.selector;
    }

    function test_CanSwap() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(SOROS),
                tokenOut: address(C98),
                amountIn: 1_000 * 1e18,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            SOROS_C98_POOL,
            SwapDirection.Token1ToToken0
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(SOROS),
                tokenOut: address(C98),
                amountIn: 1_000 * 1e18,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: true
            }),
            SOROS_C98_POOL,
            SwapDirection.Token1ToToken0
        );
    }

    function testRevert_RabbitSwapInvalidPool() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(ldaDiamond), amountIn);

        // Use _buildUniV3SwapData from base class
        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: address(0), // Invalid pool address
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        // Use _buildBaseRoute from base class
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(SOROS),
                tokenOut: address(C98),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
    }

    function testRevert_RabbitSwapInvalidRecipient() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(ldaDiamond), amountIn);

        // Use _buildUniV3SwapData from base class
        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: SOROS_C98_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(0) // Invalid recipient address
            })
        );

        // Use _buildBaseRoute from base class
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(SOROS),
                tokenOut: address(C98),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
    }
}
