// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { IVelodromeV2PoolCallee } from "lifi/Interfaces/IVelodromeV2PoolCallee.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { TestBase } from "../utils/TestBase.sol";

contract MockVelodromeV2FlashLoanCallbackReceiver is IVelodromeV2PoolCallee {
    event HookCalled(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes data
    );

    function hook(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        emit HookCalled(sender, amount0, amount1, data);
    }
}

contract LiFiDexAggregatorTest is TestBase {
    IVelodromeV2Router internal constant VELODROME_V2_ROUTER =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal constant VELODROME_V2_FACTORY_REGISTRY =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    IERC20 internal constant STG_TOKEN =
        IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97);
    IERC20 internal constant USDC_E_TOKEN =
        IERC20(0x7F5c764cBc14f9669B88837ca1490cCa17c31607);

    LiFiDEXAggregator internal liFiDEXAggregator;
    MockVelodromeV2FlashLoanCallbackReceiver
        internal mockFlashloanCallbackReceiver;

    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );
    event HookCalled(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes data
    );

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

        _testSwap(
            SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC_OPTIMISM,
                amountIn: 1_000 * 1e6,
                tokenOut: address(STG_TOKEN),
                stable: false, // - NOT USED!
                fee: 3000, // - NOT USED!
                direction: 0,
                callback: false
            })
        );

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_NoStable_Reverse() public {
        // first perform the forward swap.
        test_CanSwapViaVelodromeV2_NoStable();

        vm.startPrank(USER_SENDER);
        _testSwap(
            SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(STG_TOKEN),
                amountIn: 500 * 1e18,
                tokenOut: ADDRESS_USDC_OPTIMISM,
                stable: false, // - NOT USED!
                fee: 3000, // - NOT USED!
                direction: 1,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_Stable() public {
        vm.startPrank(USER_SENDER);
        _testSwap(
            SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: ADDRESS_USDC_OPTIMISM,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: true, // - NOT USED!
                fee: 500, // - NOT USED!
                direction: 0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_Stable_Reverse() public {
        // first perform the forward stable swap.
        test_CanSwapViaVelodromeV2_Stable();

        vm.startPrank(USER_SENDER);

        _testSwap(
            SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(USDC_E_TOKEN),
                amountIn: 500 * 1e6,
                tokenOut: ADDRESS_USDC_OPTIMISM,
                stable: true, // - NOT USED!
                fee: 500, // - NOT USED!
                direction: 1,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_FromDexAggregator() public {
        // fund dex aggregator contract so that the contract holds USDC
        deal(ADDRESS_USDC_OPTIMISM, address(liFiDEXAggregator), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            SwapTestParams({
                from: address(liFiDEXAggregator),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC_OPTIMISM,
                amountIn: IERC20(ADDRESS_USDC_OPTIMISM).balanceOf(
                    address(liFiDEXAggregator)
                ) - 1, // has to be current dex aggregator balance - 1
                tokenOut: address(USDC_E_TOKEN),
                stable: true, // - NOT USED!
                fee: 500, // - NOT USED!
                direction: 0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_FlashloanCallback() public {
        mockFlashloanCallbackReceiver = new MockVelodromeV2FlashLoanCallbackReceiver();

        vm.startPrank(USER_SENDER);
        _testSwap(
            SwapTestParams({
                from: address(USER_SENDER),
                to: address(mockFlashloanCallbackReceiver),
                tokenIn: ADDRESS_USDC_OPTIMISM,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: true, // - NOT USED!
                fee: 500, // - NOT USED!
                direction: 0,
                callback: true
            })
        );
        vm.stopPrank();
    }

    struct SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        bool stable;
        uint24 fee;
        uint8 direction;
        bool callback;
    }

    /**
     * @dev Helper function to test a VelodromeV2 swap.
     * Uses a struct to group parameters and reduce stack depth.
     */
    function _testSwap(SwapTestParams memory params) internal {
        // get expected output amounts from the router.
        IVelodromeV2Router.Route[]
            memory routes = new IVelodromeV2Router.Route[](1);
        routes[0] = IVelodromeV2Router.Route({
            from: params.tokenIn,
            to: params.tokenOut,
            stable: params.stable,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        uint256[] memory amounts = VELODROME_V2_ROUTER.getAmountsOut(
            params.amountIn,
            routes
        );
        emit log_named_uint("Expected amount out", amounts[1]);

        // Retrieve the pool address.
        address pool = VELODROME_V2_ROUTER.poolFor(
            params.tokenIn,
            params.tokenOut,
            params.stable,
            VELODROME_V2_FACTORY_REGISTRY
        );
        emit log_named_uint("Pool address:", uint256(uint160(pool)));

        // if tokens come from the aggregator (address(liFiDEXAggregator)), use command code 1; otherwise, use 2.
        uint8 commandCode = params.from == address(liFiDEXAggregator)
            ? uint8(1)
            : uint8(2);

        // build the route.
        bytes memory route = abi.encodePacked(
            commandCode, // command code: 1 for processMyERC20 (contract funds), 2 for processUserERC20 (user funds)
            params.tokenIn, // token to swap from
            uint8(1), // number of pools in this swap
            uint16(65535), // share (100%)
            uint8(6), // pool type: VelodromeV2
            pool, // pool address
            params.direction, // direction: 0 for normal, 1 for reverse
            params.to, // recipient
            uint24(params.fee), // fee (e.g., 3000 or 500) - NOT USED!
            params.stable ? uint8(1) : uint8(0), // stable flag: 1 for true, 0 for false // currently not used - NOT USED!
            params.callback ? uint8(1) : uint8(0) // callback flag: 1 for true, 0 for false
        );

        // approve the aggregator to spend tokenIn.
        IERC20(params.tokenIn).approve(
            address(liFiDEXAggregator),
            params.amountIn
        );

        // capture initial token balances.
        uint256 initialTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 initialTokenOut = IERC20(params.tokenOut).balanceOf(params.to);
        emit log_named_uint("Initial tokenIn balance", initialTokenIn);

        address from = params.from == address(liFiDEXAggregator)
            ? USER_SENDER
            : params.from;
        if (params.callback == true) {
            vm.expectEmit(true, false, false, false);
            emit HookCalled(
                address(liFiDEXAggregator),
                0,
                0,
                abi.encode(params.tokenIn)
            );
        }
        vm.expectEmit(true, true, true, true);
        emit Route(
            from,
            params.to,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            amounts[1],
            amounts[1]
        );

        // execute the swap
        liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            amounts[1],
            params.to,
            route
        );

        uint256 finalTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 finalTokenOut = IERC20(params.tokenOut).balanceOf(params.to);
        emit log_named_uint("TokenIn spent", initialTokenIn - finalTokenIn);
        emit log_named_uint(
            "TokenOut received",
            finalTokenOut - initialTokenOut
        );

        assertEq(
            initialTokenIn - finalTokenIn,
            params.amountIn,
            "TokenIn amount mismatch"
        );
        assertEq(
            finalTokenOut - initialTokenOut,
            amounts[1],
            "TokenOut amount mismatch"
        );
    }
}
