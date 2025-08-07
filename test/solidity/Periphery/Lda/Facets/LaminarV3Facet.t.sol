// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract LaminarV3FacetTest is BaseUniV3StyleDexFacetTest {
    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);
    IERC20 internal constant LHYPE =
        IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562);

    address internal constant WHYPE_LHYPE_POOL =
        0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45;

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
        functionSelectors[1] = uniV3Facet.laminarV3SwapCallback.selector;
        addFacet(address(ldaDiamond), address(uniV3Facet), functionSelectors);

        uniV3Facet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e18;

        // Fund the user with WHYPE
        deal(address(WHYPE), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WHYPE.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: WHYPE_LHYPE_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(WHYPE),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // Record balances
        uint256 inBefore = WHYPE.balanceOf(USER_SENDER);
        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Execute swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
            address(WHYPE),
            amountIn,
            address(LHYPE),
            0,
            USER_SENDER,
            route
        );

        // Verify
        uint256 inAfter = WHYPE.balanceOf(USER_SENDER);
        uint256 outAfter = LHYPE.balanceOf(USER_SENDER);
        assertEq(inBefore - inAfter, amountIn, "WHYPE spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive LHYPE");

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 1_000 * 1e18;

        // fund the aggregator directly
        deal(address(WHYPE), address(ldaDiamond), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: WHYPE_LHYPE_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(WHYPE),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
            swapData
        );

        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Withdraw 1 wei to avoid slot-undrain protection
        coreRouteFacet.processRoute(
            address(WHYPE),
            amountIn - 1,
            address(LHYPE),
            0,
            USER_SENDER,
            route
        );

        uint256 outAfter = LHYPE.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive LHYPE");

        vm.stopPrank();
    }
}
