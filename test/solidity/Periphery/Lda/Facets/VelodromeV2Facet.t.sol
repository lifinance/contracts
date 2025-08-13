// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IVelodromeV2PoolCallee } from "lifi/Interfaces/IVelodromeV2PoolCallee.sol";
import { IVelodromeV2PoolFactory } from "lifi/Interfaces/IVelodromeV2PoolFactory.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { VelodromeV2Facet } from "lifi/Periphery/Lda/Facets/VelodromeV2Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseDexFacetTest } from "../BaseDexFacet.t.sol";

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

contract VelodromeV2FacetTest is BaseDexFacetTest {
    VelodromeV2Facet internal velodromeV2Facet;

    // ==================== Velodrome V2 specific variables ====================
    IVelodromeV2Router internal constant VELODROME_V2_ROUTER =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal constant VELODROME_V2_FACTORY_REGISTRY =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;

    MockVelodromeV2FlashLoanCallbackReceiver
        internal mockFlashloanCallbackReceiver;

    // Velodrome V2 structs
    struct VelodromeV2SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        bool stable;
        SwapDirection direction;
        CallbackStatus callbackStatus;
    }

    struct MultiHopTestParams {
        address tokenIn;
        address tokenMid;
        address tokenOut;
        address pool1;
        address pool2;
        uint256[] amounts1;
        uint256[] amounts2;
        uint256 pool1Fee;
        uint256 pool2Fee;
    }

    struct ReserveState {
        uint256 reserve0Pool1;
        uint256 reserve1Pool1;
        uint256 reserve0Pool2;
        uint256 reserve1Pool2;
    }

    struct VelodromeV2SwapData {
        address pool;
        SwapDirection direction;
        address recipient;
        CallbackStatus callbackStatus;
    }

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "optimism",
            blockNumber: 133999121
        });
    }

    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        velodromeV2Facet = new VelodromeV2Facet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = velodromeV2Facet.swapVelodromeV2.selector;
        return (address(velodromeV2Facet), functionSelectors);
    }

    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        velodromeV2Facet = VelodromeV2Facet(facetAddress);
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85); // USDC
        tokenMid = IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97); // STG
        tokenOut = IERC20(0x7F5c764cBc14f9669B88837ca1490cCa17c31607); // STG
        // pools vary by test; set per-test as locals or use POOL_IN_OUT for the default path
    }

    // ============================ Velodrome V2 Tests ============================

    // no stable swap
    function test_CanSwap() public override {
        deal(address(tokenIn), address(USER_SENDER), 1_000 * 1e6);

        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: address(tokenIn),
                amountIn: 1_000 * 1e6,
                tokenOut: address(tokenOut),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        vm.stopPrank();
    }

    function test_CanSwap_NoStable_Reverse() public {
        // first perform the forward swap.
        test_CanSwap();

        uint256 amountIn = IERC20(address(tokenOut)).balanceOf(USER_SENDER);
        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(tokenOut), // USDC.e from first swap
                amountIn: amountIn,
                tokenOut: address(tokenIn), // USDC
                stable: false,
                direction: SwapDirection.Token1ToToken0,
                callbackStatus: CallbackStatus.Disabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_Stable() public {
        deal(address(tokenIn), address(USER_SENDER), 1_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(tokenIn),
                amountIn: 1_000 * 1e6,
                tokenOut: address(tokenOut),
                stable: true,
                direction: SwapDirection.Token0ToToken1,
                callbackStatus: CallbackStatus.Disabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_Stable_Reverse() public {
        // first perform the forward stable swap.
        test_CanSwap_Stable();

        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(tokenOut),
                amountIn: 500 * 1e6,
                tokenOut: address(tokenIn),
                stable: false,
                direction: SwapDirection.Token1ToToken0,
                callbackStatus: CallbackStatus.Disabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // // fund dex aggregator contract so that the contract holds USDC
        deal(address(tokenIn), address(ldaDiamond), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(ldaDiamond),
                to: address(USER_SENDER),
                tokenIn: address(tokenIn),
                amountIn: IERC20(address(tokenIn)).balanceOf(
                    address(ldaDiamond)
                ) - 1, // adjust for slot undrain protection: subtract 1 token so that the
                // aggregator's balance isn't completely drained, matching the contract's safeguard
                tokenOut: address(tokenOut),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callbackStatus: CallbackStatus.Disabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FlashloanCallback() public {
        deal(address(tokenIn), address(USER_SENDER), 1_000 * 1e6);

        mockFlashloanCallbackReceiver = new MockVelodromeV2FlashLoanCallbackReceiver();

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(mockFlashloanCallbackReceiver),
                tokenIn: address(tokenIn),
                amountIn: 1_000 * 1e6,
                tokenOut: address(tokenOut),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callbackStatus: CallbackStatus.Enabled
            })
        );
        vm.stopPrank();
    }

    // Override the abstract test with VelodromeV2 implementation
    function test_CanSwap_MultiHop() public override {
        deal(address(tokenIn), address(USER_SENDER), 1_000 * 1e6);

        vm.startPrank(USER_SENDER);

        // Setup routes and get amounts
        MultiHopTestParams memory params = _setupRoutes(
            address(tokenIn),
            address(tokenMid),
            address(tokenOut),
            false,
            false
        );

        // Get initial reserves BEFORE the swap
        ReserveState memory initialReserves;
        (
            initialReserves.reserve0Pool1,
            initialReserves.reserve1Pool1,

        ) = IVelodromeV2Pool(params.pool1).getReserves();
        (
            initialReserves.reserve0Pool2,
            initialReserves.reserve1Pool2,

        ) = IVelodromeV2Pool(params.pool2).getReserves();

        // Build route and execute swap
        SwapTestParams[] memory swapParams = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        // First hop: USDC -> USDC.e (stable)
        swapParams[0] = SwapTestParams({
            tokenIn: params.tokenIn,
            tokenOut: params.tokenMid,
            amountIn: 1000 * 1e6,
            sender: USER_SENDER,
            recipient: params.pool2, // Send to next pool
            commandType: CommandType.ProcessUserERC20
        });

        // Build first hop swap data
        swapData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                recipient: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        swapParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: params.amounts1[1], // Use output from first hop
            sender: params.pool2,
            recipient: USER_SENDER,
            commandType: CommandType.ProcessOnePool
        });

        // Build second hop swap data
        swapData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Use the base _buildMultiHopRoute
        bytes memory route = _buildMultiHopRoute(swapParams, swapData);

        // Approve and execute
        IERC20(params.tokenIn).approve(address(ldaDiamond), 1000 * 1e6);

        // vm.expectEmit(true, true, true, true);
        // emit Route(
        //     USER_SENDER,
        //     USER_SENDER,
        //     params.tokenIn,
        //     params.tokenOut,
        //     1000 * 1e6,
        //     params.amounts2[1],
        //     params.amounts2[1]
        // );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: 1000 * 1e6,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            route
        );
        _verifyReserves(params, initialReserves);

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop_WithStable() public {
        deal(address(tokenIn), address(USER_SENDER), 1_000 * 1e6);

        vm.startPrank(USER_SENDER);

        // Setup routes and get amounts for stable->volatile path
        MultiHopTestParams memory params = _setupRoutes(
            address(tokenIn),
            address(tokenOut),
            address(tokenMid),
            true, // stable pool for first hop
            false // volatile pool for second hop
        );

        // Get initial reserves BEFORE the swap
        ReserveState memory initialReserves;
        (
            initialReserves.reserve0Pool1,
            initialReserves.reserve1Pool1,

        ) = IVelodromeV2Pool(params.pool1).getReserves();
        (
            initialReserves.reserve0Pool2,
            initialReserves.reserve1Pool2,

        ) = IVelodromeV2Pool(params.pool2).getReserves();

        // Build route and execute swap
        SwapTestParams[] memory hopParams = new SwapTestParams[](2);
        bytes[] memory hopData = new bytes[](2);

        // First hop: USDC -> USDC.e (stable)
        hopParams[0] = SwapTestParams({
            tokenIn: params.tokenIn,
            tokenOut: params.tokenMid,
            amountIn: 1000 * 1e6,
            sender: USER_SENDER,
            recipient: params.pool2, // Send to next pool
            commandType: CommandType.ProcessUserERC20
        });

        hopData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                recipient: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        hopParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: params.amounts1[1], // Use output from first hop
            sender: params.pool2,
            recipient: USER_SENDER,
            commandType: CommandType.ProcessOnePool
        });

        hopData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        bytes memory route = _buildMultiHopRoute(hopParams, hopData);

        // Approve and execute
        IERC20(params.tokenIn).approve(address(ldaDiamond), 1000 * 1e6);

        // vm.expectEmit(true, true, true, true);
        // emit Route(
        //     USER_SENDER,
        //     USER_SENDER,
        //     params.tokenIn,
        //     params.tokenOut,
        //     1000 * 1e6,
        //     params.amounts2[1],
        //     params.amounts2[1]
        // );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: 1000 * 1e6,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            route
        );
        _verifyReserves(params, initialReserves);
        vm.stopPrank();
    }

    function testRevert_InvalidPoolOrRecipient() public {
        vm.startPrank(USER_SENDER);

        // Get a valid pool address first for comparison
        address validPool = VELODROME_V2_ROUTER.poolFor(
            address(tokenIn),
            address(tokenMid),
            false,
            VELODROME_V2_FACTORY_REGISTRY
        );

        // --- Test case 1: Zero pool address ---
        // 1. Create the specific swap data blob
        bytes memory swapDataZeroPool = abi.encodePacked(
            VelodromeV2Facet.swapVelodromeV2.selector,
            address(0), // Invalid pool
            uint8(SwapDirection.Token1ToToken0),
            USER_SENDER,
            uint8(CallbackStatus.Disabled)
        );

        // 2. Create the full route with the length-prefixed swap data
        bytes memory routeWithZeroPool = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(tokenIn),
            uint8(1),
            FULL_SHARE,
            uint16(swapDataZeroPool.length), // Length prefix
            swapDataZeroPool
        );

        IERC20(address(tokenIn)).approve(address(ldaDiamond), 1000 * 1e6);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: 1000 * 1e6,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            routeWithZeroPool,
            InvalidCallData.selector
        );

        // --- Test case 2: Zero recipient address ---
        bytes memory swapDataZeroRecipient = abi.encodePacked(
            VelodromeV2Facet.swapVelodromeV2.selector,
            validPool,
            uint8(SwapDirection.Token1ToToken0),
            address(0), // Invalid recipient
            uint8(CallbackStatus.Disabled)
        );

        bytes memory routeWithZeroRecipient = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(tokenIn),
            uint8(1),
            FULL_SHARE,
            uint16(swapDataZeroRecipient.length), // Length prefix
            swapDataZeroRecipient
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: 1000 * 1e6,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            routeWithZeroRecipient,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    function testRevert_WrongPoolReserves() public {
        vm.startPrank(USER_SENDER);

        // Setup multi-hop route: USDC -> STG -> USDC.e
        MultiHopTestParams memory params = _setupRoutes(
            address(tokenIn),
            address(tokenMid),
            address(tokenOut),
            false,
            false
        );

        // Build multi-hop route
        SwapTestParams[] memory hopParams = new SwapTestParams[](2);
        bytes[] memory hopData = new bytes[](2);

        // First hop: USDC -> USDC.e (stable)
        hopParams[0] = SwapTestParams({
            tokenIn: params.tokenIn,
            tokenOut: params.tokenMid,
            amountIn: 1000 * 1e6,
            sender: USER_SENDER,
            recipient: params.pool2, // Send to next pool
            commandType: CommandType.ProcessUserERC20
        });

        hopData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                recipient: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        hopParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: 0, // Not used in ProcessOnePool
            sender: params.pool2,
            recipient: USER_SENDER,
            commandType: CommandType.ProcessOnePool
        });

        hopData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        bytes memory route = _buildMultiHopRoute(hopParams, hopData);

        deal(address(tokenIn), USER_SENDER, 1000 * 1e6);

        IERC20(address(tokenIn)).approve(address(ldaDiamond), 1000 * 1e6);

        // Mock getReserves for the second pool (which uses processOnePool) to return zero reserves
        vm.mockCall(
            params.pool2,
            abi.encodeWithSelector(IVelodromeV2Pool.getReserves.selector),
            abi.encode(0, 0, block.timestamp)
        );

        vm.expectRevert(WrongPoolReserves.selector);

        coreRouteFacet.processRoute(
            address(tokenIn),
            1000 * 1e6,
            address(tokenOut),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    // ============================ Velodrome V2 Helper Functions ============================

    /**
     * @dev Helper function to test a VelodromeV2 swap.
     * Uses a struct to group parameters and reduce stack depth.
     */
    function _testSwap(VelodromeV2SwapTestParams memory params) internal {
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
        CommandType commandCode = params.from == address(ldaDiamond)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;

        // 1. Pack the data for the specific swap FIRST
        bytes memory swapData = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: pool,
                direction: params.direction,
                recipient: params.to,
                callbackStatus: params.callbackStatus
            })
        );
        // build the route.
        bytes memory route = abi.encodePacked(
            uint8(commandCode),
            params.tokenIn,
            uint8(1), // num splits
            FULL_SHARE,
            uint16(swapData.length), // <--- Add length prefix
            swapData
        );

        // approve the aggregator to spend tokenIn.
        IERC20(params.tokenIn).approve(address(ldaDiamond), params.amountIn);

        // capture initial token balances.
        uint256 initialTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        emit log_named_uint("Initial tokenIn balance", initialTokenIn);

        ExpectedEvent[] memory expectedEvents = new ExpectedEvent[](1);
        if (params.callbackStatus == CallbackStatus.Enabled) {
            bytes[] memory eventParams = new bytes[](4);
            eventParams[0] = abi.encode(address(ldaDiamond));
            eventParams[1] = abi.encode(uint256(0));
            eventParams[2] = abi.encode(uint256(0));
            eventParams[3] = abi.encode(abi.encode(params.tokenIn));

            expectedEvents[0] = ExpectedEvent({
                checkTopic1: true,
                checkTopic2: false,
                checkTopic3: false,
                checkData: false,
                eventSelector: keccak256(
                    "HookCalled(address,uint256,uint256,bytes)"
                ),
                eventParams: eventParams
            });
        } else {
            expectedEvents = new ExpectedEvent[](0);
        }

        // vm.expectEmit(true, true, true, true);
        // emit Route(
        //     from,
        //     params.to,
        //     params.tokenIn,
        //     params.tokenOut,
        //     params.amountIn,
        //     amounts[1],
        //     amounts[1]
        // );

        // execute the swap
        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: params.amountIn,
                sender: params.from,
                recipient: params.to,
                commandType: params.from == address(ldaDiamond)
                    ? CommandType.ProcessMyERC20
                    : CommandType.ProcessUserERC20
            }),
            route,
            expectedEvents
        );
    }

    // Helper function to set up routes and get amounts
    function _setupRoutes(
        address tokenIn,
        address tokenMid,
        address tokenOut,
        bool isStableFirst,
        bool isStableSecond
    ) private view returns (MultiHopTestParams memory params) {
        params.tokenIn = tokenIn;
        params.tokenMid = tokenMid;
        params.tokenOut = tokenOut;

        // Setup first hop route
        IVelodromeV2Router.Route[]
            memory routes1 = new IVelodromeV2Router.Route[](1);
        routes1[0] = IVelodromeV2Router.Route({
            from: tokenIn,
            to: tokenMid,
            stable: isStableFirst,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        params.amounts1 = VELODROME_V2_ROUTER.getAmountsOut(
            1000 * 1e6,
            routes1
        );

        // Setup second hop route
        IVelodromeV2Router.Route[]
            memory routes2 = new IVelodromeV2Router.Route[](1);
        routes2[0] = IVelodromeV2Router.Route({
            from: tokenMid,
            to: tokenOut,
            stable: isStableSecond,
            factory: address(VELODROME_V2_FACTORY_REGISTRY)
        });
        params.amounts2 = VELODROME_V2_ROUTER.getAmountsOut(
            params.amounts1[1],
            routes2
        );

        // Get pool addresses
        params.pool1 = VELODROME_V2_ROUTER.poolFor(
            tokenIn,
            tokenMid,
            isStableFirst,
            VELODROME_V2_FACTORY_REGISTRY
        );

        params.pool2 = VELODROME_V2_ROUTER.poolFor(
            tokenMid,
            tokenOut,
            isStableSecond,
            VELODROME_V2_FACTORY_REGISTRY
        );

        // Get pool fees info
        params.pool1Fee = IVelodromeV2PoolFactory(
            VELODROME_V2_FACTORY_REGISTRY
        ).getFee(params.pool1, isStableFirst);
        params.pool2Fee = IVelodromeV2PoolFactory(
            VELODROME_V2_FACTORY_REGISTRY
        ).getFee(params.pool2, isStableSecond);

        return params;
    }

    function _buildVelodromeV2SwapData(
        VelodromeV2SwapData memory params
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                VelodromeV2Facet.swapVelodromeV2.selector,
                params.pool,
                uint8(params.direction),
                params.recipient,
                params.callbackStatus
            );
    }

    function _verifyReserves(
        MultiHopTestParams memory params,
        ReserveState memory initialReserves
    ) private {
        // Get reserves after swap
        (
            uint256 finalReserve0Pool1,
            uint256 finalReserve1Pool1,

        ) = IVelodromeV2Pool(params.pool1).getReserves();
        (
            uint256 finalReserve0Pool2,
            uint256 finalReserve1Pool2,

        ) = IVelodromeV2Pool(params.pool2).getReserves();

        address token0Pool1 = IVelodromeV2Pool(params.pool1).token0();
        address token0Pool2 = IVelodromeV2Pool(params.pool2).token0();

        // Calculate exact expected changes
        uint256 amountInAfterFees = 1000 *
            1e6 -
            ((1000 * 1e6 * params.pool1Fee) / 10000);

        // Assert exact reserve changes for Pool1
        if (token0Pool1 == params.tokenIn) {
            // tokenIn is token0, so reserve0 should increase and reserve1 should decrease
            assertEq(
                finalReserve0Pool1 - initialReserves.reserve0Pool1,
                amountInAfterFees,
                "Pool1 reserve0 (tokenIn) change incorrect"
            );
            assertEq(
                initialReserves.reserve1Pool1 - finalReserve1Pool1,
                params.amounts1[1],
                "Pool1 reserve1 (tokenMid) change incorrect"
            );
        } else {
            // tokenIn is token1, so reserve1 should increase and reserve0 should decrease
            assertEq(
                finalReserve1Pool1 - initialReserves.reserve1Pool1,
                amountInAfterFees,
                "Pool1 reserve1 (tokenIn) change incorrect"
            );
            assertEq(
                initialReserves.reserve0Pool1 - finalReserve0Pool1,
                params.amounts1[1],
                "Pool1 reserve0 (tokenMid) change incorrect"
            );
        }

        // Assert exact reserve changes for Pool2
        if (token0Pool2 == params.tokenMid) {
            // tokenMid is token0, so reserve0 should increase and reserve1 should decrease
            assertEq(
                finalReserve0Pool2 - initialReserves.reserve0Pool2,
                params.amounts1[1] -
                    ((params.amounts1[1] * params.pool2Fee) / 10000),
                "Pool2 reserve0 (tokenMid) change incorrect"
            );
            assertEq(
                initialReserves.reserve1Pool2 - finalReserve1Pool2,
                params.amounts2[1],
                "Pool2 reserve1 (tokenOut) change incorrect"
            );
        } else {
            // tokenMid is token1, so reserve1 should increase and reserve0 should decrease
            assertEq(
                finalReserve1Pool2 - initialReserves.reserve1Pool2,
                params.amounts1[1] -
                    ((params.amounts1[1] * params.pool2Fee) / 10000),
                "Pool2 reserve1 (tokenMid) change incorrect"
            );
            assertEq(
                initialReserves.reserve0Pool2 - finalReserve0Pool2,
                params.amounts2[1],
                "Pool2 reserve0 (tokenOut) change incorrect"
            );
        }
    }
}
