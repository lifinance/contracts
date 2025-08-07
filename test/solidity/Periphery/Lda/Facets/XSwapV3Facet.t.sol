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

    function _addDexFacet() internal override {
        uniV3Facet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3Facet.swapUniV3.selector;
        functionSelectors[1] = uniV3Facet.xswapCallback.selector;
        addFacet(address(ldaDiamond), address(uniV3Facet), functionSelectors);

        uniV3Facet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e6;
        deal(address(USDC_E), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        USDC_E.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: USDC_E_WXDC_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(USDC_E),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // Record balances before swap
        uint256 inBefore = USDC_E.balanceOf(USER_SENDER);
        uint256 outBefore = WXDC.balanceOf(USER_SENDER);

        // Execute swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
            address(USDC_E),
            amountIn,
            address(WXDC),
            0,
            USER_SENDER,
            route
        );

        // Verify balances after swap
        uint256 inAfter = USDC_E.balanceOf(USER_SENDER);
        uint256 outAfter = WXDC.balanceOf(USER_SENDER);
        assertEq(inBefore - inAfter, amountIn, "USDC.e spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive WXDC");

        vm.stopPrank();
    }

    /// @notice single-pool swap: aggregator contract sends USDC.e → user receives WXDC
    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 5_000 * 1e6;

        // fund the aggregator
        deal(address(USDC_E), address(ldaDiamond), amountIn);

        vm.startPrank(USER_SENDER);

        // Account for slot-undrain protection
        uint256 swapAmount = amountIn - 1;

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: USDC_E_WXDC_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(USDC_E),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
            swapData
        );

        // Record balances before swap
        uint256 outBefore = WXDC.balanceOf(USER_SENDER);

        coreRouteFacet.processRoute(
            address(USDC_E),
            swapAmount,
            address(WXDC),
            0,
            USER_SENDER,
            route
        );

        // Verify balances after swap
        uint256 outAfter = WXDC.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive WXDC");

        vm.stopPrank();
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
