// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { TestBase } from "../utils/TestBase.sol";
import { console2 } from "forge-std/console2.sol";

interface IUniswapV2Pair {
    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );
}

contract LiFiDexAggregator is TestBase {
    IVelodromeV2Router internal velodromeV2Router =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal velodromeV2FactoryRegistry =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    IERC20 internal USDC_TOKEN =
        IERC20(0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85);
    IERC20 internal STG_TOKEN =
        IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97);
    IERC20 internal USDC_E_TOKEN =
        IERC20(0x7F5c764cBc14f9669B88837ca1490cCa17c31607);

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

    function test_CanSwapViaVelodromeV2_NoStable() public {
        vm.startPrank(USER_SENDER);
        uint256 amountIn = 1_000_000;

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_TOKEN),
            to: address(STG_TOKEN),
            stable: false,
            factory: address(velodromeV2FactoryRegistry)
        });
        uint256[] memory amounts = velodromeV2Router.getAmountsOut(
            amountIn,
            routes
        );
        console2.log("amounts[0]", amounts[0]);
        console2.log("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = velodromeV2Router.poolFor(
            address(USDC_TOKEN),
            address(STG_TOKEN),
            false,
            velodromeV2FactoryRegistry
        );
        console2.log("Pool address:", uint256(uint160(pool)));

        // Retrieve reserves from the pool
        // (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast) = IVelodromeV2Pool(pool).getReserves();
        // console2.log("Reserves:", reserve0, reserve1, blockTimestampLast);

        // build the route for swapVelodromeV2 (poolType == 6):
        bytes memory route = abi.encodePacked(
            uint8(2), // command code: processUserERC20
            address(USDC_TOKEN), // token to swap from
            uint8(1), // number of pools in this swap
            uint16(65535), // share (100%)
            uint8(6), // pool type 6: VelodromeV2
            pool, // pool address
            uint8(0), // direction: 0 (assume token0 -> token1)
            address(USER_SENDER), // recipient of output tokens
            uint24(3000), // fee (3000 in parts per million, ~0.3%)
            uint8(0) // stable flag: 0 (false)
        );

        // approve the aggregator to spend USDC from msg.sender
        USDC_TOKEN.approve(address(liFiDEXAggregator), amountIn);

        // capture initial token balances
        uint256 initialUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        uint256 initialSTG = STG_TOKEN.balanceOf(address(USER_SENDER));
        console2.log("initialUSDC:", initialUSDC);

        // call processRoute on the aggregator
        liFiDEXAggregator.processRoute(
            address(USDC_TOKEN), // tokenIn
            amountIn, // amountIn
            address(STG_TOKEN), // tokenOut
            amounts[1], // amountOutMin
            address(USER_SENDER), // to (recipient)
            route // route encoding
        );

        // capture final token balances.
        uint256 finalUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        uint256 finalSTG = STG_TOKEN.balanceOf(address(USER_SENDER));

        console2.log("USDC spent:", initialUSDC - finalUSDC);
        console2.log("STG received:", finalSTG - initialSTG);

        // assert the swap outcome:
        //    - The USDC balance should decrease by amountIn
        //    - The STG balance should increase exactly by amounts[1]
        assertEq(initialUSDC - finalUSDC, amountIn, "USDC amount mismatch");
        assertEq(finalSTG - initialSTG, amounts[1], "STG amount mismatch");

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_Stable() public {
        vm.startPrank(USER_SENDER);
        uint256 amountIn = 1_000_000;

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_TOKEN),
            to: address(USDC_E_TOKEN),
            stable: false,
            factory: address(velodromeV2FactoryRegistry)
        });
        uint256[] memory amounts = velodromeV2Router.getAmountsOut(
            amountIn,
            routes
        );
        console2.log("amounts[0]", amounts[0]);
        console2.log("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = velodromeV2Router.poolFor(
            address(USDC_TOKEN),
            address(USDC_E_TOKEN),
            true,
            velodromeV2FactoryRegistry
        );
        console2.log("Pool address:", uint256(uint160(pool)));

        // Retrieve reserves from the pool
        (
            uint256 reserve0,
            uint256 reserve1,
            uint256 blockTimestampLast
        ) = IVelodromeV2Pool(pool).getReserves();
        console2.log("Reserves:", reserve0, reserve1, blockTimestampLast);

        // build the route for swapVelodromeV2 (poolType == 6):
        bytes memory route = abi.encodePacked(
            uint8(2), // command code: processUserERC20
            address(USDC_TOKEN), // token to swap from
            uint8(1), // number of pools in this swap
            uint16(65535), // share (100%)
            uint8(6), // pool type 6: VelodromeV2
            pool, // pool address
            uint8(0), // direction: 0 (assume token0 -> token1)
            address(USER_SENDER), // recipient of output tokens
            uint24(500), // fee (500 in parts per million, ~0.05%)
            uint8(1) // stable flag: 1 (true)
        );

        // approve the aggregator to spend USDC from msg.sender
        USDC_TOKEN.approve(address(liFiDEXAggregator), amountIn);

        // capture initial token balances
        uint256 initialUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        uint256 initialUSDC_E = USDC_E_TOKEN.balanceOf(address(USER_SENDER));
        console2.log("initialUSDC:", initialUSDC);

        // call processRoute on the aggregator
        liFiDEXAggregator.processRoute(
            address(USDC_TOKEN), // tokenIn
            amountIn, // amountIn
            address(USDC_E_TOKEN), // tokenOut
            amounts[1], // amountOutMin
            address(USER_SENDER), // to (recipient)
            route // route encoding
        );

        // capture final token balances.
        uint256 finalUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        uint256 finalUSDC_E = USDC_E_TOKEN.balanceOf(address(USER_SENDER));

        console2.log("USDC spent:", initialUSDC - finalUSDC);
        console2.log("USDC_E received:", finalUSDC_E - initialUSDC_E);

        // assert the swap outcome:
        //    - The USDC balance should decrease by amountIn
        //    - The USDC_E balance should increase exactly by amounts[1]
        assertEq(initialUSDC - finalUSDC, amountIn, "USDC amount mismatch");
        assertEq(
            finalUSDC_E - initialUSDC_E,
            amounts[1],
            "USDC_E amount mismatch"
        );

        vm.stopPrank();
    }
}
