// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract XSwapV3FacetTest is BaseUniV3StyleDexFacetTest {
    address internal constant USDC_E_WXDC_POOL =
        0x81B4afF811E94fb084A0d3B3ca456D09AeC14EB0;

    /// @dev our two tokens: USDC.e and wrapped XDC
    IERC20 internal constant USDC_E =
        IERC20(0x2A8E898b6242355c290E1f4Fc966b8788729A4D4);
    IERC20 internal constant WXDC =
        IERC20(0x951857744785E80e2De051c32EE7b25f9c458C42);

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_XDC",
            blockNumber: 89279495
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.xswapCallback.selector;
    }

    function test_CanSwap() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(USDC_E),
                tokenOut: address(WXDC),
                amountIn: 1_000 * 1e6,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            USDC_E_WXDC_POOL,
            SwapDirection.Token0ToToken1
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(USDC_E),
                tokenOut: address(WXDC),
                amountIn: 5_000 * 1e6 - 1, // Account for slot-undrain
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessMyERC20
            }),
            USDC_E_WXDC_POOL,
            SwapDirection.Token0ToToken1
        );
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: XSwap V3 multi-hop unsupported due to AS requirement.
        // XSwap V3 does not support a "one-pool" second hop today, because
        // the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. XSwap V3's swap() immediately reverts on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }
}
