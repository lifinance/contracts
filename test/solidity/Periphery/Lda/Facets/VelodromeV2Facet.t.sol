// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IVelodromeV2PoolCallee } from "lifi/Interfaces/IVelodromeV2PoolCallee.sol";
import { IVelodromeV2PoolFactory } from "lifi/Interfaces/IVelodromeV2PoolFactory.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { VelodromeV2Facet } from "lifi/Periphery/LDA/Facets/VelodromeV2Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseDEXFacetTest } from "../BaseDEXFacet.t.sol";

/// @title VelodromeV2FacetTest
/// @notice Optimism Velodrome V2 tests covering stable/volatile pools, aggregator/user flows, multi-hop, and precise reserve accounting.
/// @dev Includes a flashloan callback path to assert event expectations and reserve deltas.
contract VelodromeV2FacetTest is BaseDEXFacetTest {
    /// @notice Facet proxy bound to the diamond after setup.
    VelodromeV2Facet internal velodromeV2Facet;

    // ==== Constants ====
    /// @notice Router used to compute amounts and resolve pools.
    IVelodromeV2Router internal constant VELODROME_V2_ROUTER =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    /// @notice Factory registry used by the router for pool lookup.
    address internal constant VELODROME_V2_FACTORY_REGISTRY =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;

    /// @notice Mock receiver for exercising the pool's flashloan callback hook.
    MockVelodromeV2FlashLoanCallbackReceiver
        internal mockFlashloanCallbackReceiver;

    // ==== Types ====
    /// @notice Enables/disables the flashloan callback during swap.
    enum CallbackStatus {
        Disabled, // 0
        Enabled // 1
    }

    /// @notice Encapsulates a single Velodrome V2 swap request under test.
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

    /// @notice Parameters and precomputed amounts used by multi-hop tests.
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

    /// @notice Snapshot of reserve states across two pools for before/after assertions.
    struct ReserveState {
        uint256 reserve0Pool1;
        uint256 reserve1Pool1;
        uint256 reserve0Pool2;
        uint256 reserve1Pool2;
    }

    /// @notice Swap data payload packed for VelodromeV2Facet.
    struct VelodromeV2SwapData {
        address pool;
        SwapDirection direction;
        address destinationAddress;
        CallbackStatus callbackStatus;
    }

    // ==== Setup Functions ====

    /// @notice Picks Optimism fork and block height.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "optimism",
            blockNumber: 133999121
        });
    }

    /// @notice Deploys facet and returns its swap selector.
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

    /// @notice Sets the facet instance to the diamond proxy.
    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        velodromeV2Facet = VelodromeV2Facet(facetAddress);
    }

    /// @notice Assigns tokens used in tests; pool addresses are resolved per-test from the router.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85); // USDC
        tokenMid = IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97); // STG
        tokenOut = IERC20(0x7F5c764cBc14f9669B88837ca1490cCa17c31607); // USDC.e
        // pools vary by test; and they are fetched inside tests
    }

    /// @notice Default amount for 6-decimal tokens on Optimism.
    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }

    // ==== Test Cases ====

    function test_CanSwap() public override {
        deal(
            address(tokenIn),
            address(USER_SENDER),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn(),
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
        deal(
            address(tokenIn),
            address(USER_SENDER),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn(),
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
                amountIn: _getDefaultAmountForTokenIn() / 2,
                tokenOut: address(tokenIn),
                stable: true,
                direction: SwapDirection.Token1ToToken0,
                callbackStatus: CallbackStatus.Disabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // fund dex aggregator contract so that the contract holds USDC
        deal(
            address(tokenIn),
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(ldaDiamond),
                to: address(USER_SENDER),
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn() - 1, // adjust for slot undrain protection: subtract 1 token so that the
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
        deal(
            address(tokenIn),
            address(USER_SENDER),
            _getDefaultAmountForTokenIn()
        );

        mockFlashloanCallbackReceiver = new MockVelodromeV2FlashLoanCallbackReceiver();

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(mockFlashloanCallbackReceiver),
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn(),
                tokenOut: address(tokenOut),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callbackStatus: CallbackStatus.Enabled
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        deal(
            address(tokenIn),
            address(USER_SENDER),
            _getDefaultAmountForTokenIn()
        );

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
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: params.pool2, // Send to next pool
            commandType: CommandType.DistributeUserERC20
        });

        // Build first hop swap data
        swapData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        swapParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: params.amounts1[1], // Use output from first hop
            sender: params.pool2,
            minOut: 0,
            destinationAddress: USER_SENDER, // Send to next pool
            commandType: CommandType.DispatchSinglePoolSwap
        });

        // Build second hop swap data
        swapData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Use the base _buildMultiHopRoute
        bytes memory route = _buildMultiHopRoute(swapParams, swapData);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route
        );
        _verifyReserves(params, initialReserves);

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop_WithStable() public {
        deal(
            address(tokenIn),
            address(USER_SENDER),
            _getDefaultAmountForTokenIn()
        );

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
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: params.pool2, // Send to next pool
            commandType: CommandType.DistributeUserERC20
        });

        hopData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        hopParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: params.amounts1[1], // Use output from first hop
            sender: params.pool2,
            minOut: 0,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DispatchSinglePoolSwap
        });

        hopData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        bytes memory route = _buildMultiHopRoute(hopParams, hopData);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route
        );
        _verifyReserves(params, initialReserves);
        vm.stopPrank();
    }

    function testRevert_InvalidPoolOrDestinationAddress() public {
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
        bytes memory swapDataZeroPool = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: address(0), // Invalid pool
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataZeroPool,
            InvalidCallData.selector
        );

        // --- Test case 2: Zero destination address ---
        bytes
            memory swapDataZeroDestinationAddress = _buildVelodromeV2SwapData(
                VelodromeV2SwapData({
                    pool: validPool,
                    direction: SwapDirection.Token1ToToken0,
                    destinationAddress: address(0), // Invalid destination address
                    callbackStatus: CallbackStatus.Disabled
                })
            );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataZeroDestinationAddress,
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
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: params.pool2, // Send to next pool
            commandType: CommandType.DistributeUserERC20
        });

        hopData[0] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool1,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: params.pool2,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        // Second hop: USDC.e -> STG (volatile)
        hopParams[1] = SwapTestParams({
            tokenIn: params.tokenMid,
            tokenOut: params.tokenOut,
            amountIn: 0, // Not used in DispatchSinglePoolSwap
            minOut: 0,
            sender: params.pool2,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DispatchSinglePoolSwap
        });

        hopData[1] = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: params.pool2,
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: USER_SENDER,
                callbackStatus: CallbackStatus.Disabled
            })
        );

        bytes memory route = _buildMultiHopRoute(hopParams, hopData);

        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        IERC20(address(tokenIn)).approve(
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        // Mock getReserves for the second pool (which uses dispatchSinglePoolSwap) to return zero reserves
        vm.mockCall(
            params.pool2,
            abi.encodeWithSelector(IVelodromeV2Pool.getReserves.selector),
            abi.encode(0, 0, block.timestamp)
        );

        vm.expectRevert(WrongPoolReserves.selector);

        coreRouteFacet.processRoute(
            address(tokenIn),
            _getDefaultAmountForTokenIn(),
            address(tokenOut),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    /// @notice Empty test as VelodromeV2 does not use callbacks for regular swaps
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    /// @dev Note: While VelodromeV2 has flashloan callbacks, they are separate from swap callbacks
    function testRevert_CallbackFromUnexpectedSender() public override {
        // VelodromeV2 does not use callbacks for swaps - test intentionally empty
    }

    /// @notice Empty test as VelodromeV2 does not use callbacks for regular swaps
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    /// @dev Note: While VelodromeV2 has flashloan callbacks, they are separate from swap callbacks
    function testRevert_SwapWithoutCallback() public override {
        // VelodromeV2 does not use callbacks for swaps - test intentionally empty
    }

    // ==== Helper Functions ====

    /**
     * @notice Helper to execute a VelodromeV2 swap with optional callback expectation and strict event checking.
     * @param params The swap request including direction and whether callback is enabled.
     * @dev Computes expected outputs via router, builds payload, and asserts Route + optional HookCalled event.
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
        uint256[] memory expectedOutput = VELODROME_V2_ROUTER.getAmountsOut(
            params.amountIn,
            routes
        );

        // Retrieve the pool address.
        address pool = VELODROME_V2_ROUTER.poolFor(
            params.tokenIn,
            params.tokenOut,
            params.stable,
            VELODROME_V2_FACTORY_REGISTRY
        );

        // if tokens come from the aggregator (address(liFiDEXAggregator)), use command code 1; otherwise, use 2.
        CommandType commandCode = params.from == address(ldaDiamond)
            ? CommandType.DistributeSelfERC20
            : CommandType.DistributeUserERC20;

        // 1. Pack the data for the specific swap FIRST
        bytes memory swapData = _buildVelodromeV2SwapData(
            VelodromeV2SwapData({
                pool: pool,
                direction: params.direction,
                destinationAddress: params.to,
                callbackStatus: params.callbackStatus
            })
        );
        // build the route.
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: params.amountIn,
                minOut: expectedOutput[1],
                sender: params.from,
                destinationAddress: params.to,
                commandType: commandCode
            }),
            swapData
        );

        ExpectedEvent[] memory expectedEvents = new ExpectedEvent[](1);
        if (params.callbackStatus == CallbackStatus.Enabled) {
            bytes[] memory eventParams = new bytes[](4);
            eventParams[0] = abi.encode(address(ldaDiamond));
            eventParams[1] = abi.encode(uint256(0));
            eventParams[2] = abi.encode(uint256(0));
            eventParams[3] = abi.encode(abi.encode(params.tokenIn));

            expectedEvents[0] = ExpectedEvent({
                checkTopic1: false,
                checkTopic2: false,
                checkTopic3: false,
                checkData: false,
                eventSelector: keccak256(
                    "HookCalled(address,uint256,uint256,bytes)"
                ),
                eventParams: eventParams,
                indexedParamIndices: new uint8[](0)
            });
        } else {
            expectedEvents = new ExpectedEvent[](0);
        }

        // execute the swap
        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: params.amountIn,
                minOut: expectedOutput[1],
                sender: params.from,
                destinationAddress: params.to,
                commandType: params.from == address(ldaDiamond)
                    ? CommandType.DistributeSelfERC20
                    : CommandType.DistributeUserERC20
            }),
            route,
            expectedEvents,
            false,
            RouteEventVerification({
                expectedExactOut: expectedOutput[1],
                checkData: true
            })
        );
    }

    /// @notice Builds routes and computes amounts for two-hop paths using the router.
    /// @param tokenIn First hop input.
    /// @param tokenMid Intermediate token between hops.
    /// @param tokenOut Final output token.
    /// @param isStableFirst Whether hop1 uses a stable pool.
    /// @param isStableSecond Whether hop2 uses a stable pool.
    /// @return params MultiHopTestParams including pool addresses, amounts and pool fees.
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
            _getDefaultAmountForTokenIn(),
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

    /// @notice Encodes swap payload for VelodromeV2Facet.swapVelodromeV2.
    /// @param params pool/direction/destinationAddress/callback status.
    /// @return Packed bytes payload.
    function _buildVelodromeV2SwapData(
        VelodromeV2SwapData memory params
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                VelodromeV2Facet.swapVelodromeV2.selector,
                params.pool,
                uint8(params.direction),
                params.destinationAddress,
                params.callbackStatus
            );
    }

    /// @notice Verifies exact reserve deltas on both pools against computed amounts and fees.
    /// @param params Multi-hop parameters returned by `_setupRoutes`.
    /// @param initialReserves Reserves captured before the swap.
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
        uint256 amountInAfterFees = _getDefaultAmountForTokenIn() -
            ((_getDefaultAmountForTokenIn() * params.pool1Fee) / 10000);

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

contract MockVelodromeV2FlashLoanCallbackReceiver is IVelodromeV2PoolCallee {
    // ==== Events ====
    /// @notice Emitted by the mock to validate callback plumbing during tests.
    event HookCalled(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes data
    );

    /// @notice Simple hook that emits `HookCalled` with passthrough data.
    function hook(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        emit HookCalled(sender, amount0, amount1, data);
    }
}
