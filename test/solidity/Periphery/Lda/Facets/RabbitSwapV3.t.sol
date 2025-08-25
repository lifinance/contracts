// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/LDA/Facets/UniV3StyleFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseUniV3StyleDEXFacetTest } from "../BaseUniV3StyleDEXFacet.t.sol";

/// @title RabbitSwapV3FacetTest
/// @notice Viction UniV3-style tests for RabbitSwap V3 pools.
/// @dev Covers invalid pool/recipient edge cases plus standard setup.
contract RabbitSwapV3FacetTest is BaseUniV3StyleDEXFacetTest {
    /// @notice Selects Viction fork and block height used in tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "viction",
            blockNumber: 94490946
        });
    }

    /// @notice Returns RabbitSwap V3 callback selector used during swaps.
    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.rabbitSwapV3SwapCallback.selector;
    }

    /// @notice Sets tokenIn/out and pool address for RabbitSwap V3 on Viction.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xB786D9c8120D311b948cF1e5Aa48D8fBacf477E2); // SOROS
        tokenOut = IERC20(0x0Fd0288AAAE91eaF935e2eC14b23486f86516c8C); // C98
        poolInOut = 0xF10eFaE2DdAC396c4ef3c52009dB429A120d0C0D; // pool
    }

    /// @notice Negative: zero pool must be rejected by facet call data validation.
    function testRevert_RabbitSwapInvalidPool() public {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), _getDefaultAmountForTokenIn());

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: address(0), // Invalid pool address
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Negative: zero recipient must be rejected by facet call data validation.
    function testRevert_RabbitSwapInvalidRecipient() public {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), _getDefaultAmountForTokenIn());

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: poolInOut,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(0) // Invalid recipient address
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }
}
