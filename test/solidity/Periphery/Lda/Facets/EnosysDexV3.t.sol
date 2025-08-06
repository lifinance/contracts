// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract EnosysDexV3FacetTest is BaseUniV3StyleDexFacetTest {
    /// @dev HLN token on Flare
    IERC20 internal constant HLN =
        IERC20(0x140D8d3649Ec605CF69018C627fB44cCC76eC89f);

    /// @dev USDT0 token on Flare
    IERC20 internal constant USDT0 =
        IERC20(0xe7cd86e13AC4309349F30B3435a9d337750fC82D);

    /// @dev The single EnosysDexV3 pool for HLN–USDT0
    address internal constant ENOSYS_V3_POOL =
        0xA7C9E7343bD8f1eb7000F25dE5aeb52c6B78B1b7;

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_FLARE",
            blockNumber: 42652369
        });
    }

    function _addDexFacet() internal override {
        uniV3Facet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3Facet.swapUniV3.selector;
        functionSelectors[1] = uniV3Facet.enosysdexV3SwapCallback.selector;
        addFacet(address(ldaDiamond), address(uniV3Facet), functionSelectors);

        uniV3Facet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    /// @notice Single‐pool swap: USER sends HLN → receives USDT0
    function test_CanSwap() public override {
        // Mint 1 000 HLN to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(HLN), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        HLN.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: ENOSYS_V3_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(HLN), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // Record balances before swap
        uint256 inBefore = HLN.balanceOf(USER_SENDER);
        uint256 outBefore = USDT0.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
            address(HLN),
            amountIn,
            address(USDT0),
            0,
            USER_SENDER,
            route
        );

        // Verify that HLN was spent and some USDT0 was received
        uint256 inAfter = HLN.balanceOf(USER_SENDER);
        uint256 outAfter = USDT0.balanceOf(USER_SENDER);

        assertEq(inBefore - inAfter, amountIn, "HLN spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive USDT0");

        vm.stopPrank();
    }

    /// @notice Single‐pool swap: aggregator holds HLN → user receives USDT0
    function test_CanSwap_FromDexAggregator() public override {
        // Fund the aggregator with 1 000 HLN
        uint256 amountIn = 1_000 * 1e18;
        deal(address(HLN), address(coreRouteFacet), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: ENOSYS_V3_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20), // aggregator's funds
            address(HLN), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDT0.balanceOf(USER_SENDER);

        coreRouteFacet.processRoute(
            address(HLN),
            swapAmount,
            address(USDT0),
            0,
            USER_SENDER,
            route
        );

        // Verify that some USDT0 was received
        uint256 outAfter = USDT0.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive USDT0");

        vm.stopPrank();
    }
}
