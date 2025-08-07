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

    /// @dev a liquid USDT on HyperEVM
    IERC20 internal constant USDT0 =
        IERC20(0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb);
    /// @dev WHYPE on HyperEVM
    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);

    struct HyperswapV3Params {
        CommandType commandCode; // ProcessMyERC20 or ProcessUserERC20
        address tokenIn; // Input token address
        address recipient; // Address receiving the output tokens
        address pool; // HyperswapV3 pool address
        bool zeroForOne; // Direction of the swap
    }

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_HYPEREVM",
            blockNumber: 4433562
        });
    }

    function _addDexFacet() internal override {
        uniV3Facet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3Facet.swapUniV3.selector;
        functionSelectors[1] = uniV3Facet.hyperswapV3SwapCallback.selector;
        addFacet(address(ldaDiamond), address(uniV3Facet), functionSelectors);

        uniV3Facet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e6; // 1000 USDT0

        deal(address(USDT0), USER_SENDER, amountIn);

        // user approves
        vm.prank(USER_SENDER);
        USDT0.approve(address(ldaDiamond), amountIn);

        // fetch the real pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(USDT0),
            address(WHYPE),
            3000
        );

        // Create the params struct for quoting
        IHyperswapV3QuoterV2.QuoteExactInputSingleParams
            memory params = IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
                tokenIn: address(USDT0),
                tokenOut: address(WHYPE),
                amountIn: amountIn,
                fee: 3000,
                sqrtPriceLimitX96: 0
            });

        // Get the quote using the struct
        (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
            params
        );

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: pool,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(USDT0),
            uint8(1), // 1 pool
            FULL_SHARE, // FULL_SHARE
            uint16(swapData.length), // length prefix
            swapData
        );

        // expect the Route event
        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            address(USDT0),
            address(WHYPE),
            amountIn,
            quoted,
            quoted
        );

        // execute
        vm.prank(USER_SENDER);
        coreRouteFacet.processRoute(
            address(USDT0),
            amountIn,
            address(WHYPE),
            quoted,
            USER_SENDER,
            route
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 1_000 * 1e6; // 1000 USDT0

        // Fund dex aggregator contract
        deal(address(USDT0), address(ldaDiamond), amountIn);

        // fetch the real pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(USDT0),
            address(WHYPE),
            3000
        );

        // Create the params struct for quoting
        IHyperswapV3QuoterV2.QuoteExactInputSingleParams
            memory params = IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
                tokenIn: address(USDT0),
                tokenOut: address(WHYPE),
                amountIn: amountIn - 1, // Subtract 1 to match slot undrain protection
                fee: 3000,
                sqrtPriceLimitX96: 0
            });

        // Get the quote using the struct
        (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
            params
        );

        // Build route using our helper function
        // bytes memory route = _buildHyperswapV3Route(
        //     HyperswapV3Params({
        //         commandCode: CommandType.ProcessMyERC20,
        //         tokenIn: address(USDT0),
        //         recipient: USER_SENDER,
        //         pool: pool,
        //         zeroForOne: true // USDT0 < WHYPE
        //     })
        // );

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: pool,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(USDT0),
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        // expect the Route event
        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            address(USDT0),
            address(WHYPE),
            amountIn - 1, // Account for slot undrain protection
            quoted,
            quoted
        );

        // execute
        vm.prank(USER_SENDER);
        coreRouteFacet.processRoute(
            address(USDT0),
            amountIn - 1, // Account for slot undrain protection
            address(WHYPE),
            quoted,
            USER_SENDER,
            route
        );
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: HyperswapV3 multi-hop unsupported due to AS requirement.
        // HyperswapV3 does not support a "one-pool" second hop today, because
        // the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. HyperswapV3's swap() immediately reverts on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }
}
