// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHyperswapV3Factory } from "lifi/Interfaces/IHyperswapV3Factory.sol";
import { IHyperswapV3QuoterV2 } from "lifi/Interfaces/IHyperswapV3QuoterV2.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract HyperswapV3FacetTest is BaseUniV3StyleDexFacetTest {
    /// @dev HyperswapV3 router on HyperEVM chain
    IHyperswapV3Factory internal constant HYPERSWAP_FACTORY =
        IHyperswapV3Factory(0xB1c0fa0B789320044A6F623cFe5eBda9562602E3);
    /// @dev HyperswapV3 quoter on HyperEVM chain
    IHyperswapV3QuoterV2 internal constant HYPERSWAP_QUOTER =
        IHyperswapV3QuoterV2(0x03A918028f22D9E1473B7959C927AD7425A45C7C);

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "hyperevm",
            blockNumber: 4433562
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.hyperswapV3SwapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb); // USDT0
        tokenOut = IERC20(0x5555555555555555555555555555555555555555); // WHYPE
        uniV3Pool = IHyperswapV3Factory(
            0xB1c0fa0B789320044A6F623cFe5eBda9562602E3
        ).getPool(address(tokenIn), address(tokenOut), 3000);
    }

    function test_CanSwap() public override {
        // Get pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(tokenIn),
            address(tokenOut),
            3000
        );

        uint256 amountIn = 1_000 * 1e6;
        // (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
        //     IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
        //         tokenIn: address(TOKEN_IN),
        //         tokenOut: address(TOKEN_OUT),
        //         amountIn: amountIn,
        //         fee: 3000,
        //         sqrtPriceLimitX96: 0
        //     })
        // );

        // expect the Route event
        // vm.expectEmit(true, true, true, true);
        // emit Route(
        //     USER_SENDER,
        //     USER_SENDER,
        //     address(TOKEN_IN),
        //     address(TOKEN_OUT),
        //     amountIn,
        //     quoted,
        //     quoted
        // );

        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            pool,
            SwapDirection.Token1ToToken0
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Get pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(tokenIn),
            address(tokenOut),
            3000
        );

        uint256 amountIn = 1_000 * 1e6;
        uint256 swapAmount = amountIn - 1; // Account for slot-undrain

        // (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
        //     IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
        //         tokenIn: address(USDT0),
        //         tokenOut: address(WHYPE),
        //         amountIn: swapAmount,
        //         fee: 3000,
        //         sqrtPriceLimitX96: 0
        //     })
        // );

        // expect the Route event
        // vm.expectEmit(true, true, true, true);
        // emit Route(
        //     USER_SENDER,
        //     USER_SENDER,
        //     address(TOKEN_IN),
        //     address(TOKEN_OUT),
        //     amountIn - 1, // Account for slot undrain protection
        //     quoted,
        //     quoted
        // );

        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: swapAmount,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessMyERC20
            }),
            pool,
            SwapDirection.Token1ToToken0
        );
    }
}
