// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract RabbitSwapV3FacetTest is BaseUniV3StyleDexFacetTest {
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "viction",
            blockNumber: 94490946
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.rabbitSwapV3SwapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xB786D9c8120D311b948cF1e5Aa48D8fBacf477E2); // SOROS
        tokenOut = IERC20(0x0Fd0288AAAE91eaF935e2eC14b23486f86516c8C); // C98
        uniV3Pool = 0xF10eFaE2DdAC396c4ef3c52009dB429A120d0C0D; // pool
        aggregatorUndrainMinusOne = true;
    }

    function test_CanSwap() public override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.ProcessUserERC20,
                amountIn: 1_000 * 1e18
            })
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        _executeUniV3StyleSwapAuto(
            UniV3AutoSwapParams({
                commandType: CommandType.ProcessMyERC20,
                amountIn: 1_000 * 1e18 - 1 // Account for slot-undrain
            })
        );
    }

    function testRevert_RabbitSwapInvalidPool() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(tokenIn), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), amountIn);

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
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            route,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    function testRevert_RabbitSwapInvalidRecipient() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(tokenIn), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), amountIn);

        // Use _buildUniV3SwapData from base class
        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: uniV3Pool,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(0) // Invalid recipient address
            })
        );

        // Use _buildBaseRoute from base class
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            route,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }
}
