// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { TestBase } from "../utils/TestBase.sol";
import { console } from "forge-std/console.sol";

contract LiFiDexAggregator is TestBase {
    IVelodromeV2Router internal velodromeV2Router =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal velodromeV2FactoryRegistry =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    IERC20 internal USDC_TOKEN =
        IERC20(0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85);
    IERC20 internal STG_TOKEN =
        IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97);

    LiFiDEXAggregator internal liFiDEXAggregator;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_OPTIMISM";
        customBlockNumberForForking = 133999121;
        initTestBase();

        address[] memory privileged = new address[](0);
        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0),
            privileged,
            USER_DIAMOND_OWNER
        ); // dont care about bento and privilaged users
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
    }

    function test_CanSwapViaVelodromeV2() public {
        // check pool
        // address pool = velodromeV2Router.swapExactTokensForTokens(address(USDC_TOKEN), address(STG_TOKEN), false, velodromeV2FactoryRegistry);
        // address pool = velodromeV2Router.poolFor(address(USDC_TOKEN), address(STG_TOKEN), false, velodromeV2FactoryRegistry);
        // console.log("pool");
        // console.log(pool);
        // (uint256 reserve0, uint256 reserve1, ) = IVelodromeV2Pool(pool).getReserves();
        // console.log("reserve0");
        // console.log(reserve0);
        // console.log("reserve1");
        // console.log(reserve1);
        // IVelodromeV2Pool(pool).swap(amount0Out, amount1Out, to, new bytes(0));
        // --- Construct a route that triggers a VelodromeV2 swap via processUserERC20 ---
        // The expected route layout:
        //   [ command code (uint8) ]
        //   [ token address (20 bytes) ] -- token to pull from user (tokenIn)
        //   [ number of pools (uint8) ]
        //   For each pool:
        //       [ share (uint16) ]
        //       [ poolType (uint8) ]  -> we set to 6 for VelodromeV2
        //       [ pool address (20 bytes) ]
        //       [ direction (uint8) ] -> 0 means token0 in, token1 out
        //       [ recipient address (20 bytes) ]
        //       [ fee (uint24) ]
        //       [ stable flag (uint8) ] -> 0 for volatile, 1 for stable; here we choose 0.
        //
        // we use command code 2 to invoke processUserERC20.
        // bytes memory route = abi.encodePacked(
        //     uint8(2),                // command code: processUserERC20
        //     address(tokenIn),        // token address (tokenIn)
        //     uint8(1),                // number of pools = 1
        //     uint16(type(uint16).max),// share = 65535 (100%)
        //     uint8(6),                // poolType = 6 (VelodromeV2)
        //     address(mockPool),       // pool address
        //     uint8(0),                // direction: 0 = token0 in, token1 out
        //     recipient,               // recipient address for output token
        //     uint24(3000),            // fee: 3000 (0.3% fee)
        //     uint8(0)                 // stable flag: 0 = volatile swap
        // );
        // // User-supplied amount: 1e18 tokenIn.
        // uint256 amountIn = 1e18;
        // // We set amountOutMin = 0 for the test.
        // uint256 amountOutMin = 0;
        // // Have the user approve the aggregator to spend tokenIn.
        // vm.prank(USER_SENDER);
        // tokenIn.approve(address(liFiDEXAggregator), type(uint256).max);
        // // The aggregator will pull tokens from msg.sender. So we impersonate the user.
        // vm.prank(USER_SENDER);
        // uint256 amountOut = liFiDEXAggregator.processRoute(
        //     address(tokenIn),
        //     amountIn,
        //     address(tokenOut),
        //     amountOutMin,
        //     recipient,
        //     route
        // );
        // // Check that some output was received by the recipient.
        // uint256 recipientBalance = tokenOut.balanceOf(recipient);
        // assertGt(amountOut, 0);
        // assertEq(recipientBalance, amountOut);
    }
}
