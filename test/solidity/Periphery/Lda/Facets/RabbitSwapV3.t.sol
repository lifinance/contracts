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

    function _addDexFacet() internal override {
        uniV3Facet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3Facet.swapUniV3.selector;
        functionSelectors[1] = uniV3Facet.rabbitSwapV3SwapCallback.selector;
        addFacet(address(ldaDiamond), address(uniV3Facet), functionSelectors);

        uniV3Facet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e18;

        // fund the user with SOROS
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: SOROS_C98_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // record balances before swap
        uint256 inBefore = SOROS.balanceOf(USER_SENDER);
        uint256 outBefore = C98.balanceOf(USER_SENDER);

        // execute swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        // verify balances after swap
        uint256 inAfter = SOROS.balanceOf(USER_SENDER);
        uint256 outAfter = C98.balanceOf(USER_SENDER);
        assertEq(inBefore - inAfter, amountIn, "SOROS spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive C98");

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 1_000 * 1e18;

        // fund the aggregator directly
        deal(address(SOROS), address(ldaDiamond), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: SOROS_C98_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
            swapData
        );

        uint256 outBefore = C98.balanceOf(USER_SENDER);

        // withdraw 1 wei less to avoid slot-undrain protection
        coreRouteFacet.processRoute(
            address(SOROS),
            amountIn - 1,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        uint256 outAfter = C98.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive C98");

        vm.stopPrank();
    }

    function testRevert_RabbitSwapInvalidPool() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: address(0),
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
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

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: SOROS_C98_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(0)
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
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
