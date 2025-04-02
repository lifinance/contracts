// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { TestBase } from "../utils/TestBase.sol";
import { console2 } from "forge-std/console2.sol";

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
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);

        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_TOKEN),
            to: address(STG_TOKEN),
            stable: false,
            factory: address(velodromeV2FactoryRegistry)
        });

        uint256[] memory amounts = velodromeV2Router.getAmountsOut(
            1_000_000, // amountIn
            routes
        );

        console2.log("amounts[0]");
        console2.log(amounts[0]);
        console2.log("amounts[1]");
        console2.log(amounts[1]);

        // address pool = velodromeV2Router.poolFor(address(USDC_TOKEN), address(STG_TOKEN), false, velodromeV2FactoryRegistry);
        // console.log("pool");
        // console.log(pool);
    }
}
