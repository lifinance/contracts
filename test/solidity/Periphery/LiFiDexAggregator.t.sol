// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IVelodromeV2PoolCallee } from "lifi/Interfaces/IVelodromeV2PoolCallee.sol";
import { IVelodromeV2PoolFactory } from "lifi/Interfaces/IVelodromeV2PoolFactory.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { IAlgebraPool } from "lifi/Interfaces/IAlgebraPool.sol";
import { IAlgebraRouter } from "lifi/Interfaces/IAlgebraRouter.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { InvalidConfig, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
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

interface IOftERC4626 is IERC4626 {
    function transferShares(
        address to,
        uint256 shares
    ) external returns (uint256 assets);
    function assetsToShares(
        uint256 assets
    ) external view returns (uint256 shares);
}

/**
 * @title LiFiDexAggregatorTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract LiFiDexAggregatorTest is TestBase {
    using SafeERC20 for IERC20;

    // Common variables
    LiFiDEXAggregator internal liFiDEXAggregator;
    address[] internal privileged;

    // Test users
    address constant USER_A = address(0xA11CE);
    address constant USER_B = address(0xB0B);
    address constant USER_C = address(0xC1D);

    // Common events and errors
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

    error WrongPoolReserves();
    error PoolDoesNotExist();

    // Setup function for Apechain tests
    function setupApechain() internal {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 12912470;
        fork();

        privileged = new address[](2);
        privileged[0] = address(0xABC);
        privileged[1] = address(0xEBC);

        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            USER_DIAMOND_OWNER
        );
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
    }

    function setUp() public virtual {
        initTestBase();

        privileged = new address[](2);
        privileged[0] = address(0xABC);
        privileged[1] = address(0xEBC);
        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            USER_DIAMOND_OWNER
        );
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
    }

    function test_ContractIsSetUpCorrectly() public {
        assertEq(address(liFiDEXAggregator.BENTO_BOX()), address(0xCAFE));
        assertEq(liFiDEXAggregator.priviledgedUsers(address(0xABC)), true);
        assertEq(liFiDEXAggregator.priviledgedUsers(address(0xEBC)), true);
        assertEq(liFiDEXAggregator.owner(), USER_DIAMOND_OWNER);
    }

    function testRevert_FailsIfOwnerIsZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            address(0)
        );
    }

    // ============================ Abstract DEX Tests ============================

    /**
     * @notice Abstract test for swapping tokens from the DEX aggregator
     * Each DEX implementation should override this
     */
    function test_CanSwap_FromDexAggregator() public virtual {
        // Each DEX implementation must override this
        revert("test_CanSwap_FromDexAggregator: Not implemented");
    }

    /**
     * @notice Abstract test for multi-hop swapping
     * Each DEX implementation should override this
     */
    function test_CanSwap_MultiHop() public virtual {
        // Each DEX implementation must override this
        revert("test_CanSwap_MultiHop: Not implemented");
    }
}

/**
 * @title VelodromeV2 tests
 * @notice Tests specific to Velodrome V2 pool type
 */
contract LiFiDexAggregatorVelodromeV2Test is LiFiDexAggregatorTest {
    // ==================== Velodrome V2 specific variables ====================
    IVelodromeV2Router internal constant VELODROME_V2_ROUTER =
        IVelodromeV2Router(0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858); // optimism router
    address internal constant VELODROME_V2_FACTORY_REGISTRY =
        0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    IERC20 internal constant STG_TOKEN =
        IERC20(0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97);
    IERC20 internal constant USDC_E_TOKEN =
        IERC20(0x7F5c764cBc14f9669B88837ca1490cCa17c31607);

    MockVelodromeV2FlashLoanCallbackReceiver
        internal mockFlashloanCallbackReceiver;

    // Velodrome V2 structs
    struct SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        bool stable;
        uint8 direction;
        bool callback;
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

    // Setup function for Optimism tests
    function setupOptimism() internal {
        customRpcUrlForForking = "ETH_NODE_URI_OPTIMISM";
        customBlockNumberForForking = 133999121;
        initTestBase();

        privileged = new address[](2);
        privileged[0] = address(0xABC);
        privileged[1] = address(0xEBC);
        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            USER_DIAMOND_OWNER
        );
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
    }

    function setUp() public override {
        setupOptimism();
    }

    // ============================ Velodrome V2 Tests ============================

    function test_CanSwapViaVelodromeV2_NoStable() public {
        vm.startPrank(USER_SENDER);

        _testSwap(
            SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(STG_TOKEN),
                stable: false,
                direction: 1,
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
                tokenOut: ADDRESS_USDC,
                stable: false,
                direction: 0,
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
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: true,
                direction: 1,
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
                tokenOut: ADDRESS_USDC,
                stable: false,
                direction: 0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    // Override the abstract test with VelodromeV2 implementation
    function test_CanSwap_FromDexAggregator() public override {
        // fund dex aggregator contract so that the contract holds USDC
        deal(ADDRESS_USDC, address(liFiDEXAggregator), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            SwapTestParams({
                from: address(liFiDEXAggregator),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC,
                amountIn: IERC20(ADDRESS_USDC).balanceOf(
                    address(liFiDEXAggregator)
                ) - 1, // adjust for slot undrain protection: subtract 1 token so that the aggregator's balance isn't completely drained, matching the contract's safeguard
                tokenOut: address(USDC_E_TOKEN),
                stable: false,
                direction: 1,
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
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: false,
                direction: 1,
                callback: true
            })
        );
        vm.stopPrank();
    }

    // Override the abstract test with VelodromeV2 implementation
    function test_CanSwap_MultiHop() public override {
        vm.startPrank(USER_SENDER);

        // Setup routes and get amounts
        MultiHopTestParams memory params = _setupRoutes(
            ADDRESS_USDC,
            address(STG_TOKEN),
            address(USDC_E_TOKEN),
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

        uint256 initialBalance1 = IERC20(params.tokenIn).balanceOf(
            USER_SENDER
        );
        uint256 initialBalance2 = IERC20(params.tokenOut).balanceOf(
            USER_SENDER
        );

        // Build route and execute swap
        bytes memory route = _buildMultiHopRoute(params, USER_SENDER, 1, 1);

        // Approve and execute
        IERC20(params.tokenIn).approve(address(liFiDEXAggregator), 1000 * 1e6);

        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            params.tokenIn,
            params.tokenOut,
            1000 * 1e6,
            params.amounts2[1],
            params.amounts2[1]
        );

        liFiDEXAggregator.processRoute(
            params.tokenIn,
            1000 * 1e6,
            params.tokenOut,
            params.amounts2[1],
            USER_SENDER,
            route
        );

        _verifyUserBalances(params, initialBalance1, initialBalance2);
        _verifyReserves(params, initialReserves);

        vm.stopPrank();
    }

    function test_CanSwapViaVelodromeV2_MultiHop_WithStable() public {
        vm.startPrank(USER_SENDER);

        // Setup routes and get amounts for stable->volatile path
        MultiHopTestParams memory params = _setupRoutes(
            ADDRESS_USDC,
            address(USDC_E_TOKEN),
            address(STG_TOKEN),
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

        // Record initial balances
        uint256 initialBalance1 = IERC20(params.tokenIn).balanceOf(
            USER_SENDER
        );
        uint256 initialBalance2 = IERC20(params.tokenOut).balanceOf(
            USER_SENDER
        );

        // Build route and execute swap
        bytes memory route = _buildMultiHopRoute(params, USER_SENDER, 1, 0);

        // Approve and execute
        IERC20(params.tokenIn).approve(address(liFiDEXAggregator), 1000 * 1e6);

        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            params.tokenIn,
            params.tokenOut,
            1000 * 1e6,
            params.amounts2[1],
            params.amounts2[1]
        );

        liFiDEXAggregator.processRoute(
            params.tokenIn,
            1000 * 1e6,
            params.tokenOut,
            params.amounts2[1],
            USER_SENDER,
            route
        );

        _verifyUserBalances(params, initialBalance1, initialBalance2);
        _verifyReserves(params, initialReserves);

        vm.stopPrank();
    }

    function testRevert_VelodromeV2InvalidPoolOrRecipient() public {
        vm.startPrank(USER_SENDER);

        // Get a valid pool address first for comparison
        address validPool = VELODROME_V2_ROUTER.poolFor(
            ADDRESS_USDC,
            address(STG_TOKEN),
            false,
            VELODROME_V2_FACTORY_REGISTRY
        );

        // Test case 1: Zero pool address
        bytes memory routeWithZeroPool = abi.encodePacked(
            uint8(2), // command code: 2 for processUserERC20
            ADDRESS_USDC, // token to swap from
            uint8(1), // number of pools
            uint16(65535), // share (100%)
            uint8(6), // pool type: VelodromeV2
            address(0), // pool address <= INVALID!
            uint8(0), // direction
            USER_SENDER, // recipient
            uint24(3000), // fee - NOT USED!
            uint8(0), // stable flag - NOT USED!
            uint8(0) // callback flag
        );

        IERC20(ADDRESS_USDC).approve(address(liFiDEXAggregator), 1000 * 1e6);

        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            ADDRESS_USDC,
            1000 * 1e6,
            address(STG_TOKEN),
            0,
            USER_SENDER,
            routeWithZeroPool
        );

        // Test case 2: Zero recipient address
        bytes memory routeWithZeroRecipient = abi.encodePacked(
            uint8(2), // command code: 2 for processUserERC20
            ADDRESS_USDC, // token to swap from
            uint8(1), // number of pools
            uint16(65535), // share (100%)
            uint8(6), // pool type: VelodromeV2
            validPool, // valid pool address
            uint8(0), // direction
            address(0), // recipient <= INVALID!
            uint24(3000), // fee - NOT USED!
            uint8(0), // stable flag - NOT USED!
            uint8(0) // callback flag
        );

        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            ADDRESS_USDC,
            1000 * 1e6,
            address(STG_TOKEN),
            0,
            USER_SENDER,
            routeWithZeroRecipient
        );

        vm.stopPrank();
    }

    function testRevert_VelodromeV2WrongPoolReserves() public {
        vm.startPrank(USER_SENDER);

        // Setup multi-hop route: USDC -> STG -> USDC.e
        MultiHopTestParams memory params = _setupRoutes(
            ADDRESS_USDC,
            address(STG_TOKEN),
            address(USDC_E_TOKEN),
            false,
            false
        );

        // Build multi-hop route
        bytes memory firstHop = _buildFirstHop(
            params.tokenIn,
            params.pool1,
            params.pool2,
            1 // direction
        );

        bytes memory secondHop = _buildSecondHop(
            params.tokenMid,
            params.pool2,
            USER_SENDER,
            0 // direction
        );

        bytes memory route = bytes.concat(firstHop, secondHop);

        deal(ADDRESS_USDC, USER_SENDER, 1000 * 1e6);

        IERC20(ADDRESS_USDC).approve(address(liFiDEXAggregator), 1000 * 1e6);

        // Mock getReserves for the second pool (which uses processOnePool) to return zero reserves
        vm.mockCall(
            params.pool2,
            abi.encodeWithSelector(IVelodromeV2Pool.getReserves.selector),
            abi.encode(0, 0, block.timestamp)
        );

        vm.expectRevert(WrongPoolReserves.selector);

        liFiDEXAggregator.processRoute(
            ADDRESS_USDC,
            1000 * 1e6,
            address(USDC_E_TOKEN),
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

    // function to build first hop of the route
    function _buildFirstHop(
        address tokenIn,
        address pool1,
        address pool2,
        uint8 direction
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(2), // command: processUserERC20
                tokenIn, // tokenIn
                uint8(1), // number of pools
                uint16(65535), // share (100%)
                uint8(6), // pool type: VelodromeV2
                pool1, // first pool
                direction, // direction
                pool2, // send to second pool
                uint8(0) // no callback
            );
    }

    // function to build second hop of the route
    function _buildSecondHop(
        address tokenMid,
        address pool2,
        address recipient,
        uint8 direction
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(4), // command: processOnePool
                tokenMid, // tokenIn
                uint8(6), // pool type: VelodromeV2
                pool2, // second pool
                direction, // direction
                recipient, // final recipient
                uint8(0) // no callback
            );
    }

    // route building function
    function _buildMultiHopRoute(
        MultiHopTestParams memory params,
        address recipient,
        uint8 firstHopDirection,
        uint8 secondHopDirection
    ) private pure returns (bytes memory) {
        bytes memory firstHop = _buildFirstHop(
            params.tokenIn,
            params.pool1,
            params.pool2,
            firstHopDirection
        );

        bytes memory secondHop = _buildSecondHop(
            params.tokenMid,
            params.pool2,
            recipient,
            secondHopDirection
        );

        return bytes.concat(firstHop, secondHop);
    }

    function _verifyUserBalances(
        MultiHopTestParams memory params,
        uint256 initialBalance1,
        uint256 initialBalance2
    ) private {
        // Verify token balances
        uint256 finalBalance1 = IERC20(params.tokenIn).balanceOf(USER_SENDER);
        uint256 finalBalance2 = IERC20(params.tokenOut).balanceOf(USER_SENDER);

        assertEq(
            initialBalance1 - finalBalance1,
            1000 * 1e6,
            "Token1 spent amount mismatch"
        );
        assertEq(
            finalBalance2 - initialBalance2,
            params.amounts2[1],
            "Token2 received amount mismatch"
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

/**
 * @title Algebra tests
 * @notice Tests specific to Algebra V2 pool type
 */
contract LiFiDexAggregatorAlgebraTest is LiFiDexAggregatorTest {
    // Apechain-specific constants for fee-on-transfer test
    address private constant APE_ETH_TOKEN =
        0xcF800F4948D16F23333508191B1B1591daF70438;
    address private constant APE_USD_TOKEN =
        0xA2235d059F80e176D931Ef76b6C51953Eb3fBEf4;
    address private constant WAPE_TOKEN =
        0x48b62137EdfA95a428D35C09E44256a739F6B557;
    address private constant WETH_TOKEN =
        0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949;
    address private constant ALGEBRA_FACTORY_APECHAIN =
        0x10aA510d94E094Bd643677bd2964c3EE085Daffc;
    address private constant ALGEBRA_POOL_APECHAIN =
        0x217076aa74eFF7D54837D00296e9AEBc8c06d4F2;
    address constant REAL_TENDERLY_USER_SENDER =
        address(0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b);

    struct AlgebraSwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        bool feeOnTransfer;
        bool direction;
    }

    struct AlgebraMultiHopTestParams {
        address tokenIn;
        address tokenMid;
        address tokenOut;
        address pool1;
        address pool2;
        uint256 amountIn;
        uint256 amountOutExpected;
    }

    error AlgebraSwapUnexpected();

    function setUp() public override {
        setupApechain();
    }

    // Override the abstract test with Algebra implementation
    function test_CanSwap_FromDexAggregator() public override {
        // Fund dex aggregator contract with USDC
        deal(APE_USD_TOKEN, address(liFiDEXAggregator), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: address(liFiDEXAggregator),
                to: address(USER_SENDER),
                tokenIn: APE_USD_TOKEN,
                amountIn: IERC20(APE_USD_TOKEN).balanceOf(
                    address(liFiDEXAggregator)
                ) - 1, // Adjust for slot undrain protection
                tokenOut: address(WETH_TOKEN),
                feeOnTransfer: false,
                direction: true
            })
        );

        vm.stopPrank();
    }

    // Test for fee-on-transfer token using Apechain specific example
    function test_CanSwap_FeeOnTransferToken() public {
        // Setup Apechain environment
        setupApechain();

        // Get or fund user with APE_ETH_TOKEN tokens
        uint256 amountIn = 534451326669177;
        address holder = 0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b;
        vm.prank(holder);
        IERC20(APE_ETH_TOKEN).transfer(REAL_TENDERLY_USER_SENDER, amountIn);

        vm.startPrank(REAL_TENDERLY_USER_SENDER);

        // Approve token spending
        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), amountIn);

        // Build route for algebra swap
        bytes memory route = _buildAlgebraRoute(
            APE_ETH_TOKEN,
            amountIn,
            REAL_TENDERLY_USER_SENDER,
            ALGEBRA_POOL_APECHAIN
        );

        // Track initial balance
        uint256 beforeBalance = IERC20(WETH_TOKEN).balanceOf(
            REAL_TENDERLY_USER_SENDER
        );

        // Execute the swap
        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            amountIn,
            WETH_TOKEN,
            0, // minOut = 0 for this test
            REAL_TENDERLY_USER_SENDER,
            route
        );

        // Verify balances
        uint256 afterBalance = IERC20(WETH_TOKEN).balanceOf(
            REAL_TENDERLY_USER_SENDER
        );
        assertGt(afterBalance - beforeBalance, 0, "Should receive some WETH");

        vm.stopPrank();
    }

    // Test basic swap with Algebra
    function test_CanSwapViaAlgebra_1() public {
        vm.startPrank(0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b); // Start acting as the whale address

        // Transfer tokens from whale to USER_SENDER
        uint256 amountToTransfer = 100 * 1e18;
        IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, amountToTransfer);

        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: APE_ETH_TOKEN,
                amountIn: 10 * 1e18,
                tokenOut: address(WETH_TOKEN),
                feeOnTransfer: false,
                direction: true
            })
        );

        vm.stopPrank();
    }

    // Test swap in reverse direction
    function test_CanSwapViaAlgebra_Reverse() public {
        // First perform the forward swap to get WETH
        test_CanSwapViaAlgebra_1();

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(WETH_TOKEN),
                amountIn: 5 * 1e18,
                tokenOut: APE_USD_TOKEN,
                feeOnTransfer: false,
                direction: false
            })
        );

        vm.stopPrank();
    }

    // Override the abstract test with Algebra implementation
    function test_CanSwap_MultiHop() public override {
        vm.startPrank(USER_SENDER);

        // Setup a multi-hop swap: USDC -> WETH -> USDT
        address pool1 = _getPool(APE_USD_TOKEN, address(WETH_TOKEN));
        address pool2 = _getPool(address(WETH_TOKEN), address(WAPE_TOKEN));

        // Deal USDC to the user
        deal(APE_USD_TOKEN, USER_SENDER, 1_000 * 1e6);

        AlgebraMultiHopTestParams memory params = AlgebraMultiHopTestParams({
            tokenIn: APE_USD_TOKEN,
            tokenMid: address(WETH_TOKEN),
            tokenOut: address(WAPE_TOKEN),
            pool1: pool1,
            pool2: pool2,
            amountIn: 1_000 * 1e6,
            amountOutExpected: 990 * 1e6 // Approximate expected output after fees
        });

        uint256 initialBalance1 = IERC20(params.tokenIn).balanceOf(
            USER_SENDER
        );
        uint256 initialBalance2 = IERC20(params.tokenOut).balanceOf(
            USER_SENDER
        );

        // Build multi-hop route
        bytes memory route = _buildAlgebraMultiHopRoute(params, USER_SENDER);

        // Approve tokens
        IERC20(params.tokenIn).approve(
            address(liFiDEXAggregator),
            params.amountIn
        );

        // Execute the swap
        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            params.amountOutExpected,
            params.amountOutExpected
        );

        liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            params.amountOutExpected,
            USER_SENDER,
            route
        );

        // Verify balances changed appropriately
        uint256 finalBalance1 = IERC20(params.tokenIn).balanceOf(USER_SENDER);
        uint256 finalBalance2 = IERC20(params.tokenOut).balanceOf(USER_SENDER);

        assertEq(
            initialBalance1 - finalBalance1,
            params.amountIn,
            "TokenIn spent amount mismatch"
        );
        assertGt(finalBalance2, initialBalance2, "TokenOut not received");

        vm.stopPrank();
    }

    // Test that the proper error is thrown when algebra swap fails
    function testRevert_AlgebraSwapUnexpected() public {
        vm.startPrank(USER_SENDER);

        // Create invalid pool address
        address invalidPool = address(0x999);

        // Create a route with an invalid pool
        bytes memory invalidRoute = abi.encodePacked(
            uint8(2), // command code: 2 for processUserERC20
            APE_USD_TOKEN, // tokenIn
            uint8(1), // number of pools
            uint16(65535), // share (100%)
            uint8(7), // pool type: Algebra
            invalidPool, // invalid pool address
            uint8(1), // direction: true
            USER_SENDER // recipient
        );

        // Deal tokens to user
        deal(APE_USD_TOKEN, USER_SENDER, 1_000 * 1e6);

        // Approve tokens
        IERC20(APE_USD_TOKEN).approve(address(liFiDEXAggregator), 1_000 * 1e6);

        // Mock the algebra pool to not reset lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSelector(IAlgebraPool.swap.selector),
            abi.encode(0, 0)
        );

        // Expect the AlgebraSwapUnexpected error
        vm.expectRevert(AlgebraSwapUnexpected.selector);

        liFiDEXAggregator.processRoute(
            APE_USD_TOKEN,
            1_000 * 1e6,
            address(WETH_TOKEN),
            0,
            USER_SENDER,
            invalidRoute
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    // Helper function to build route for Apechain Algebra swap
    function _buildAlgebraRoute(
        address tokenIn,
        uint256 amountIn,
        address recipient,
        address pool
    ) internal view returns (bytes memory route) {
        address token0 = IAlgebraPool(pool).token0();
        bool zeroForOne = (tokenIn == token0);
        uint8 direction = zeroForOne ? 1 : 0;

        route = abi.encodePacked(
            uint8(2), // processUserERC20
            tokenIn, // tokenIn
            uint8(1), // one pool
            uint16(65535), // 100% share
            uint8(7), // poolType == 7 (Algebra)
            pool, // Algebra pool
            direction, // direction
            recipient // recipient
        );

        return route;
    }

    // Helper function to test an Algebra swap
    function _testAlgebraSwap(AlgebraSwapTestParams memory params) internal {
        // Find or create a pool
        address pool = _getPool(params.tokenIn, params.tokenOut);

        // Record initial balances
        uint256 initialTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 initialTokenOut = IERC20(params.tokenOut).balanceOf(params.to);

        // Build the route
        uint8 commandCode = params.from == address(liFiDEXAggregator)
            ? uint8(1)
            : uint8(2);

        bytes memory route = abi.encodePacked(
            commandCode, // 1 for contract funds, 2 for user funds
            params.tokenIn, // tokenIn
            uint8(1), // number of pools
            uint16(65535), // share (100%)
            uint8(7), // pool type: Algebra
            pool, // pool address
            params.direction ? uint8(1) : uint8(0), // direction
            params.to // recipient
        );

        // Approve tokens
        IERC20(params.tokenIn).approve(
            address(liFiDEXAggregator),
            params.amountIn
        );

        // Calculate expected output (simplified)
        uint256 expectedOutput = (params.amountIn * 99) / 100; // Assume 1% fee

        // Execute the swap
        address from = params.from == address(liFiDEXAggregator)
            ? USER_SENDER
            : params.from;

        vm.expectEmit(true, true, true, true);
        emit Route(
            from,
            params.to,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            expectedOutput,
            expectedOutput
        );

        liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            expectedOutput,
            params.to,
            route
        );

        // Verify balances
        uint256 finalTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 finalTokenOut = IERC20(params.tokenOut).balanceOf(params.to);

        assertEq(
            initialTokenIn - finalTokenIn,
            params.amountIn,
            "TokenIn amount mismatch"
        );
        assertGt(finalTokenOut, initialTokenOut, "TokenOut not received");
    }

    // Helper function to build a multi-hop route for Algebra
    function _buildAlgebraMultiHopRoute(
        AlgebraMultiHopTestParams memory params,
        address recipient
    ) internal pure returns (bytes memory) {
        // First hop: send to second pool
        bytes memory firstHop = abi.encodePacked(
            uint8(2), // command: processUserERC20
            params.tokenIn, // tokenIn
            uint8(1), // number of pools
            uint16(65535), // share (100%)
            uint8(7), // pool type: Algebra
            params.pool1, // first pool
            uint8(1), // direction: true
            params.pool2 // send to second pool
        );

        // Second hop: process through second pool to final recipient
        bytes memory secondHop = abi.encodePacked(
            uint8(4), // command: processOnePool
            params.tokenMid, // tokenIn for second hop
            uint8(7), // pool type: Algebra
            params.pool2, // second pool
            uint8(1), // direction: true
            recipient // final recipient
        );

        return bytes.concat(firstHop, secondHop);
    }

    function _getPool(
        address tokenA,
        address tokenB
    ) private view returns (address pool) {
        pool = IAlgebraRouter(ALGEBRA_FACTORY_APECHAIN).poolByPair(
            tokenA,
            tokenB
        );
        if (pool == address(0)) revert PoolDoesNotExist();
        return pool;
    }
}
