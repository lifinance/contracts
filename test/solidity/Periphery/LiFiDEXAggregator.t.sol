// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { TestBase } from "../utils/TestBase.sol";

contract LiFiDexAggregator is TestBase {
    IVelodromeV2Router internal constant VELODROME_V2_ROUTER =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal constant VELODROME_V2_FACTORY_REGISTRY =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    IERC20 internal constant USDC_TOKEN =
        IERC20(0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85);
    IERC20 internal constant STG_TOKEN =
        IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97);
    IERC20 internal constant USDC_E_TOKEN =
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
        uint256 amountIn = 1_000 * 10 ** 6; // USDC has 6 decimals

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_TOKEN),
            to: address(STG_TOKEN),
            stable: false,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        uint256[] memory amounts = VELODROME_V2_ROUTER.getAmountsOut(
            amountIn,
            routes
        );
        emit log_named_uint("amounts[0]", amounts[0]);
        emit log_named_uint("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = VELODROME_V2_ROUTER.poolFor(
            address(USDC_TOKEN),
            address(STG_TOKEN),
            false,
            VELODROME_V2_FACTORY_REGISTRY
        );
        emit log_named_uint("Pool address:", uint256(uint160(pool)));

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
        emit log_named_uint("initialUSDC:", initialUSDC);

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

        emit log_named_uint("USDC spent:", initialUSDC - finalUSDC);
        emit log_named_uint("STG received:", finalSTG - initialSTG);

        // assert the swap outcome:
        //    - The USDC balance should decrease by amountIn
        //    - The STG balance should increase exactly by amounts[1]
        assertEq(initialUSDC - finalUSDC, amountIn, "USDC amount mismatch");
        assertEq(finalSTG - initialSTG, amounts[1], "STG amount mismatch");

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_NoStable_Reverse() public {
        // reverse means we switch tokens and now we want to swap part of out tokens back
        this.test_CanSwapViaVelodromeV2_NoStable();
        vm.startPrank(USER_SENDER);
        uint256 amountIn = 500 * 10 ** 18; // STG has 18 decimals

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(STG_TOKEN),
            to: address(USDC_TOKEN),
            stable: false,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        uint256[] memory amounts = VELODROME_V2_ROUTER.getAmountsOut(
            amountIn,
            routes
        );
        emit log_named_uint("amounts[0]", amounts[0]);
        emit log_named_uint("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = VELODROME_V2_ROUTER.poolFor(
            address(STG_TOKEN),
            address(USDC_TOKEN),
            false,
            VELODROME_V2_FACTORY_REGISTRY
        );
        emit log_named_uint("Pool address:", uint256(uint160(pool)));

        // build the route for swapVelodromeV2 (poolType == 6):
        bytes memory route = abi.encodePacked(
            uint8(2), // command code: processUserERC20
            address(STG_TOKEN), // token to swap from
            uint8(1), // number of pools in this swap
            uint16(65535), // share (100%)
            uint8(6), // pool type 6: VelodromeV2
            pool, // pool address
            uint8(1), // direction: 1 (assume token1 -> token0)
            address(USER_SENDER), // recipient of output tokens
            uint24(3000), // fee (3000 in parts per million, ~0.3%)
            uint8(0) // stable flag: 0 (false)
        );

        // approve the aggregator to spend USDC from msg.sender
        STG_TOKEN.approve(address(liFiDEXAggregator), amountIn);

        // capture initial token balances
        uint256 initialSTG = STG_TOKEN.balanceOf(address(USER_SENDER));
        uint256 initialUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        emit log_named_uint("initialSTG:", initialSTG);

        // call processRoute on the aggregator
        liFiDEXAggregator.processRoute(
            address(STG_TOKEN), // tokenIn
            amountIn, // amountIn
            address(USDC_TOKEN), // tokenOut
            amounts[1], // amountOutMin
            address(USER_SENDER), // to (recipient)
            route // route encoding
        );

        // capture final token balances.
        uint256 finalSTG = STG_TOKEN.balanceOf(address(USER_SENDER));
        uint256 finalUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));

        emit log_named_uint("STG spent:", initialSTG - finalSTG);
        emit log_named_uint("USDC received:", finalUSDC - initialUSDC);

        // assert the swap outcome:
        //    - The STG balance should decrease by amountIn
        //    - The USDC balance should increase exactly by amounts[1]
        assertEq(initialSTG - finalSTG, amountIn, "STG amount mismatch");
        assertEq(finalUSDC - initialUSDC, amounts[1], "USDC amount mismatch");

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_Stable() public {
        vm.startPrank(USER_SENDER);
        uint256 amountIn = 1_000 * 10 ** 6; // USDC has 6 decimals

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_TOKEN),
            to: address(USDC_E_TOKEN),
            stable: true,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        uint256[] memory amounts = VELODROME_V2_ROUTER.getAmountsOut(
            amountIn,
            routes
        );
        emit log_named_uint("amounts[0]", amounts[0]);
        emit log_named_uint("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = VELODROME_V2_ROUTER.poolFor(
            address(USDC_TOKEN),
            address(USDC_E_TOKEN),
            true,
            VELODROME_V2_FACTORY_REGISTRY
        );
        emit log_named_uint("Pool address:", uint256(uint160(pool)));

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
        uint256 initialUSDCE = USDC_E_TOKEN.balanceOf(address(USER_SENDER));
        emit log_named_uint("initialUSDC:", initialUSDC);

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
        uint256 finalUSDCE = USDC_E_TOKEN.balanceOf(address(USER_SENDER));

        emit log_named_uint("USDC spent:", initialUSDC - finalUSDC);
        emit log_named_uint("USDC_E received:", finalUSDCE - initialUSDCE);

        // assert the swap outcome:
        //    - The USDC balance should decrease by amountIn
        //    - The USDC_E balance should increase exactly by amounts[1]
        assertEq(initialUSDC - finalUSDC, amountIn, "USDC amount mismatch");
        assertEq(
            finalUSDCE - initialUSDCE,
            amounts[1],
            "USDC_E amount mismatch"
        );

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_Stable_Reverse() public {
        // reverse means we switch tokens and now we want to swap part of out tokens back
        this.test_CanSwapViaVelodromeV2_Stable(); // swap first
        vm.startPrank(USER_SENDER);
        uint256 amountIn = 500 * 10 ** 6; // USDC_E has 6 decimals

        // get expected amounts out from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: address(USDC_E_TOKEN),
            to: address(USDC_TOKEN),
            stable: true,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        uint256[] memory amounts = VELODROME_V2_ROUTER.getAmountsOut(
            amountIn,
            routes
        );
        emit log_named_uint("amounts[0]", amounts[0]);
        emit log_named_uint("amounts[1]", amounts[1]);

        // get the pool address using the router's poolFor function.
        address pool = VELODROME_V2_ROUTER.poolFor(
            address(USDC_E_TOKEN),
            address(USDC_TOKEN),
            true,
            VELODROME_V2_FACTORY_REGISTRY
        );
        emit log_named_uint("Pool address:", uint256(uint160(pool)));

        // build the route for swapVelodromeV2 (poolType == 6):
        bytes memory route = abi.encodePacked(
            uint8(2), // command code: processUserERC20
            address(USDC_E_TOKEN), // token to swap from
            uint8(1), // number of pools in this swap
            uint16(65535), // share (100%)
            uint8(6), // pool type 6: VelodromeV2
            pool, // pool address
            uint8(1), // direction: 1 (assume token1 -> token0)
            address(USER_SENDER), // recipient of output tokens
            uint24(500), // fee (500 in parts per million, ~0.05%)
            uint8(1) // stable flag: 1 (true)
        );

        // approve the aggregator to spend USDC from msg.sender
        USDC_E_TOKEN.approve(address(liFiDEXAggregator), amountIn);

        // capture initial token balances
        uint256 initialUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));
        uint256 initialUSDCE = USDC_E_TOKEN.balanceOf(address(USER_SENDER));
        emit log_named_uint("initialUSDC:", initialUSDC);

        // call processRoute on the aggregator
        liFiDEXAggregator.processRoute(
            address(USDC_E_TOKEN), // tokenIn
            amountIn, // amountIn
            address(USDC_TOKEN), // tokenOut
            amounts[1], // amountOutMin
            address(USER_SENDER), // to (recipient)
            route // route encoding
        );

        // capture final token balances.
        uint256 finalUSDCE = USDC_E_TOKEN.balanceOf(address(USER_SENDER));
        uint256 finalUSDC = USDC_TOKEN.balanceOf(address(USER_SENDER));

        emit log_named_uint("USDC_E spent:", initialUSDCE - finalUSDCE);
        emit log_named_uint("USDC received:", finalUSDC - initialUSDC);

        // assert the swap outcome:
        //    - The USDC_E balance should decrease by amountIn
        //    - The USDC balance should increase exactly by amounts[1]
        assertEq(
            initialUSDCE - finalUSDCE,
            amountIn,
            "USDC_E amount mismatch"
        );
        assertEq(finalUSDC - initialUSDC, amounts[1], "USDC amount mismatch");

        vm.stopPrank();
    }
}
