// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { InvalidConfig, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { TestBase } from "../utils/TestBase.sol";

contract LiFiDEXAggregatorApechainTest is TestBase {
    // ———————— CONFIG ————————
    address private constant APE_ETH =
        0xcF800F4948D16F23333508191B1B1591daF70438;
    address private constant WETH = 0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949; // WTH
    address private constant ALGEBRA_POOL =
        address(0x217076aa74eFF7D54837D00296e9AEBc8c06d4F2); // the APE/USDC Algebra pool

    LiFiDEXAggregator public unpatched =
        LiFiDEXAggregator(payable(0x2D4ffb5219fC3C84905ec7CAEe2740d9dDa8271D));
    LiFiDEXAggregator public patched;

    address[] internal privileged;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 13954684;
        fork();

        privileged = new address[](2);
        privileged[0] = address(0xABC);
        privileged[1] = address(0xEBC);

        patched = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            USER_DIAMOND_OWNER
        ); // dont care about bento and privilaged users
        vm.label(address(patched), "LiFiDEXAggregator");
    }

    /// @notice build the 1‑pool route for V3/Algebra swap
    function _buildRoute(
        address tokenIn,
        uint256 amountIn,
        address recipient
    ) internal view returns (bytes memory route, bool zeroForOne) {
        address pool = ALGEBRA_POOL;
        address token0 = IVelodromeV2Pool(pool).token0();
        zeroForOne = (tokenIn == token0);
        uint8 direction = zeroForOne ? 1 : 0;

        route = abi.encodePacked(
            uint8(2), // processUserERC20
            tokenIn, // ApeETH
            uint8(1), // one pool
            uint16(65535), // 100% share
            uint8(1), // poolType == 1 (V3 / Algebra)
            pool,
            direction,
            recipient
        );
    }

    /// @notice Attempt with the raw aggregator: we under‑pay by 1 and it reverts "IIA"
    function test_Revert_InsufficientInputRaw() public {
        uint256 amountIn = 2_263_087_280_486_785_323; // some test amount
        address holder = 0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b;
        vm.prank(holder);
        IERC20(APE_ETH).transfer(USER_SENDER, amountIn);
        vm.startPrank(USER_SENDER);
        IERC20(APE_ETH).approve(address(unpatched), amountIn);

        (bytes memory route, ) = _buildRoute(APE_ETH, amountIn, USER_SENDER);
        vm.expectRevert(); // any revert from "insufficientInputAmount"
        unpatched.processRoute(
            APE_ETH,
            amountIn,
            WETH,
            0, // minOut = 0
            USER_SENDER,
            route
        );
        vm.stopPrank();
    }

    /// @notice With the patched aggregator (snapshot‐before/after) the swap now succeeds
    function test_SucceedsAfterPatch() public {
        uint256 amountIn = 2_263_087_280_486_785_323;
        address holder = 0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b;
        vm.prank(holder);
        IERC20(APE_ETH).transfer(USER_SENDER, amountIn);
        vm.startPrank(USER_SENDER);
        IERC20(APE_ETH).approve(address(patched), amountIn);

        (bytes memory route, bool zf1) = _buildRoute(
            APE_ETH,
            amountIn,
            USER_SENDER
        );
        // track USDC balance
        uint256 before = IERC20(WETH).balanceOf(USER_SENDER);

        // this no longer reverts, and we get some USDC back
        patched.processRoute(APE_ETH, amountIn, WETH, 0, USER_SENDER, route);

        uint256 balanceAfter = IERC20(WETH).balanceOf(USER_SENDER);
        assertGt(balanceAfter - before, 0, "should receive some USDC");
        vm.stopPrank();
    }
}
