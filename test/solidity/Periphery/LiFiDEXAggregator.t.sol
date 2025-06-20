// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IVelodromeV2PoolCallee } from "lifi/Interfaces/IVelodromeV2PoolCallee.sol";
import { IVelodromeV2PoolFactory } from "lifi/Interfaces/IVelodromeV2PoolFactory.sol";
import { IVelodromeV2Router } from "lifi/Interfaces/IVelodromeV2Router.sol";
import { IAlgebraPool } from "lifi/Interfaces/IAlgebraPool.sol";
import { IAlgebraRouter } from "lifi/Interfaces/IAlgebraRouter.sol";
import { IAlgebraFactory } from "lifi/Interfaces/IAlgebraFactory.sol";
import { IAlgebraQuoter } from "lifi/Interfaces/IAlgebraQuoter.sol";
import { IHyperswapV3Factory } from "lifi/Interfaces/IHyperswapV3Factory.sol";
import { IHyperswapV3QuoterV2 } from "lifi/Interfaces/IHyperswapV3QuoterV2.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { InvalidConfig, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { TestBase } from "../utils/TestBase.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { MockFeeOnTransferToken } from "../utils/MockTokenFeeOnTransfer.sol";

// Command codes for route processing
enum CommandType {
    None, // 0 - not used
    ProcessMyERC20, // 1 - processMyERC20
    ProcessUserERC20, // 2 - processUserERC20
    ProcessNative, // 3 - processNative
    ProcessOnePool, // 4 - processOnePool
    ProcessInsideBento, // 5 - processInsideBento
    ApplyPermit // 6 - applyPermit
}

// Pool type identifiers
enum PoolType {
    UniV2, // 0
    UniV3, // 1
    WrapNative, // 2
    BentoBridge, // 3
    Trident, // 4
    Curve, // 5
    VelodromeV2, // 6
    Algebra, // 7
    iZiSwap, // 8
    SyncSwapV2 // 9
}

// Direction constants
enum SwapDirection {
    Token1ToToken0, // 0
    Token0ToToken1 // 1
}

// Callback constants
enum CallbackStatus {
    Disabled, // 0
    Enabled // 1
}

// Other constants
uint16 constant FULL_SHARE = 65535; // 100% share for single pool swaps

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
/**
 * @title LiFiDexAggregatorTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract LiFiDexAggregatorTest is TestBase {
    using SafeERC20 for IERC20;

    // Common variables
    LiFiDEXAggregator internal liFiDEXAggregator;
    address[] internal privileged;

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

    // helper function to initialize the aggregator
    function _initializeDexAggregator(address owner) internal {
        privileged = new address[](1);
        privileged[0] = owner;

        liFiDEXAggregator = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            owner
        );
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
    }

    // Setup function for Apechain tests
    function setupApechain() internal {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 12912470;
        fork();

        _initializeDexAggregator(address(USER_DIAMOND_OWNER));
    }

    function setupHyperEVM() internal {
        customRpcUrlForForking = "ETH_NODE_URI_HYPEREVM";
        customBlockNumberForForking = 4433562;
        fork();

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    function setUp() public virtual {
        initTestBase();
        vm.label(USER_SENDER, "USER_SENDER");

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    function test_ContractIsSetUpCorrectly() public {
        assertEq(address(liFiDEXAggregator.BENTO_BOX()), address(0xCAFE));
        assertEq(
            liFiDEXAggregator.priviledgedUsers(address(USER_DIAMOND_OWNER)),
            true
        );
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
     * @notice Abstract test for basic token swapping functionality
     * Each DEX implementation should override this
     */
    function test_CanSwap() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
        revert("test_CanSwap: Not implemented");
    }

    /**
     * @notice Abstract test for swapping tokens from the DEX aggregator
     * Each DEX implementation should override this
     */
    function test_CanSwap_FromDexAggregator() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
        revert("test_CanSwap_FromDexAggregator: Not implemented");
    }

    /**
     * @notice Abstract test for multi-hop swapping
     * Each DEX implementation should override this
     */
    function test_CanSwap_MultiHop() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
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
    struct VelodromeV2SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        bool stable;
        SwapDirection direction;
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

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    function setUp() public override {
        setupOptimism();
    }

    //     // ============================ Velodrome V2 Tests ============================

    // no stable swap
    function test_CanSwap() public override {
        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(STG_TOKEN),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callback: false
            })
        );

        vm.stopPrank();
    }

    function test_CanSwap_NoStable_Reverse() public {
        // first perform the forward swap.
        test_CanSwap();

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(STG_TOKEN),
                amountIn: 500 * 1e18,
                tokenOut: ADDRESS_USDC,
                stable: false,
                direction: SwapDirection.Token1ToToken0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_Stable() public {
        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: true,
                direction: SwapDirection.Token0ToToken1,
                callback: false
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
                tokenIn: address(USDC_E_TOKEN),
                amountIn: 500 * 1e6,
                tokenOut: ADDRESS_USDC,
                stable: false,
                direction: SwapDirection.Token1ToToken0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // fund dex aggregator contract so that the contract holds USDC
        deal(ADDRESS_USDC, address(liFiDEXAggregator), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(liFiDEXAggregator),
                to: address(USER_SENDER),
                tokenIn: ADDRESS_USDC,
                amountIn: IERC20(ADDRESS_USDC).balanceOf(
                    address(liFiDEXAggregator)
                ) - 1, // adjust for slot undrain protection: subtract 1 token so that the aggregator's balance isn't completely drained, matching the contract's safeguard
                tokenOut: address(USDC_E_TOKEN),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FlashloanCallback() public {
        mockFlashloanCallbackReceiver = new MockVelodromeV2FlashLoanCallbackReceiver();

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(mockFlashloanCallbackReceiver),
                tokenIn: ADDRESS_USDC,
                amountIn: 1_000 * 1e6,
                tokenOut: address(USDC_E_TOKEN),
                stable: false,
                direction: SwapDirection.Token0ToToken1,
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

    function test_CanSwap_MultiHop_WithStable() public {
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

    function testRevert_InvalidPoolOrRecipient() public {
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
            uint8(CommandType.ProcessUserERC20),
            ADDRESS_USDC,
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.VelodromeV2),
            address(0),
            uint8(SwapDirection.Token1ToToken0),
            USER_SENDER,
            uint8(CallbackStatus.Disabled)
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
            uint8(CommandType.ProcessUserERC20),
            ADDRESS_USDC,
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.VelodromeV2),
            validPool,
            uint8(SwapDirection.Token1ToToken0),
            address(0),
            uint8(CallbackStatus.Disabled)
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

    function testRevert_WrongPoolReserves() public {
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
        CommandType commandCode = params.from == address(liFiDEXAggregator)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;

        // build the route.
        bytes memory route = abi.encodePacked(
            uint8(commandCode),
            params.tokenIn,
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.VelodromeV2),
            pool,
            params.direction,
            params.to,
            params.callback
                ? uint8(CallbackStatus.Enabled)
                : uint8(CallbackStatus.Disabled)
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

        assertApproxEqAbs(
            initialTokenIn - finalTokenIn,
            params.amountIn,
            1, // 1 wei tolerance
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
                uint8(CommandType.ProcessUserERC20),
                tokenIn,
                uint8(1),
                FULL_SHARE,
                uint8(PoolType.VelodromeV2),
                pool1,
                direction,
                pool2,
                uint8(CallbackStatus.Disabled)
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
                uint8(CommandType.ProcessOnePool),
                tokenMid,
                uint8(PoolType.VelodromeV2),
                pool2,
                direction,
                recipient,
                uint8(CallbackStatus.Disabled)
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

        assertApproxEqAbs(
            initialBalance1 - finalBalance1,
            1000 * 1e6,
            1, // 1 wei tolerance
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

contract AlgebraLiquidityAdderHelper {
    address public immutable TOKEN_0;
    address public immutable TOKEN_1;

    constructor(address _token0, address _token1) {
        TOKEN_0 = _token0;
        TOKEN_1 = _token1;
    }

    function addLiquidity(
        address pool,
        int24 bottomTick,
        int24 topTick,
        uint128 amount
    )
        external
        returns (uint256 amount0, uint256 amount1, uint128 liquidityActual)
    {
        // Get balances before
        uint256 balance0Before = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1Before = IERC20(TOKEN_1).balanceOf(address(this));

        // Call mint
        (amount0, amount1, liquidityActual) = IAlgebraPool(pool).mint(
            address(this),
            address(this),
            bottomTick,
            topTick,
            amount,
            abi.encode(TOKEN_0, TOKEN_1)
        );

        // Get balances after to account for fees
        uint256 balance0After = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1After = IERC20(TOKEN_1).balanceOf(address(this));

        // Calculate actual amounts transferred accounting for fees
        amount0 = balance0Before - balance0After;
        amount1 = balance1Before - balance1After;

        return (amount0, amount1, liquidityActual);
    }

    function algebraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external {
        // Check token balances
        uint256 balance0 = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1 = IERC20(TOKEN_1).balanceOf(address(this));

        // Transfer what we can, limited by actual balance
        if (amount0Owed > 0) {
            uint256 amount0ToSend = amount0Owed > balance0
                ? balance0
                : amount0Owed;
            uint256 balance0Before = IERC20(TOKEN_0).balanceOf(
                address(msg.sender)
            );
            IERC20(TOKEN_0).transfer(msg.sender, amount0ToSend);
            uint256 balance0After = IERC20(TOKEN_0).balanceOf(
                address(msg.sender)
            );
            // solhint-disable-next-line gas-custom-errors
            require(balance0After > balance0Before, "Transfer failed");
        }

        if (amount1Owed > 0) {
            uint256 amount1ToSend = amount1Owed > balance1
                ? balance1
                : amount1Owed;
            uint256 balance1Before = IERC20(TOKEN_1).balanceOf(
                address(msg.sender)
            );
            IERC20(TOKEN_1).transfer(msg.sender, amount1ToSend);
            uint256 balance1After = IERC20(TOKEN_1).balanceOf(
                address(msg.sender)
            );
            // solhint-disable-next-line gas-custom-errors
            require(balance1After > balance1Before, "Transfer failed");
        }
    }
}

/**
 * @title Algebra tests
 * @notice Tests specific to Algebra pool type
 */
contract LiFiDexAggregatorAlgebraTest is LiFiDexAggregatorTest {
    address private constant APE_ETH_TOKEN =
        0xcF800F4948D16F23333508191B1B1591daF70438;
    address private constant WETH_TOKEN =
        0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949;
    address private constant ALGEBRA_FACTORY_APECHAIN =
        0x10aA510d94E094Bd643677bd2964c3EE085Daffc;
    address private constant ALGEBRA_QUOTER_V2_APECHAIN =
        0x60A186019F81bFD04aFc16c9C01804a04E79e68B;
    address private constant ALGEBRA_POOL_APECHAIN =
        0x217076aa74eFF7D54837D00296e9AEBc8c06d4F2;
    address private constant APE_ETH_HOLDER_APECHAIN =
        address(0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b);

    address private constant IMPOSSIBLE_POOL_ADDRESS =
        0x0000000000000000000000000000000000000001;

    struct AlgebraSwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        SwapDirection direction;
        bool supportsFeeOnTransfer;
    }

    error AlgebraSwapUnexpected();

    function setUp() public override {
        setupApechain();
    }

    // Override the abstract test with Algebra implementation
    function test_CanSwap_FromDexAggregator() public override {
        // Fund LDA from whale address
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(address(liFiDEXAggregator), 1 * 1e18);

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: address(liFiDEXAggregator),
                to: address(USER_SENDER),
                tokenIn: APE_ETH_TOKEN,
                amountIn: IERC20(APE_ETH_TOKEN).balanceOf(
                    address(liFiDEXAggregator)
                ) - 1,
                tokenOut: address(WETH_TOKEN),
                direction: SwapDirection.Token0ToToken1,
                supportsFeeOnTransfer: true
            })
        );

        vm.stopPrank();
    }

    function test_CanSwap_FeeOnTransferToken() public {
        setupApechain();

        uint256 amountIn = 534451326669177;
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(APE_ETH_HOLDER_APECHAIN, amountIn);

        vm.startPrank(APE_ETH_HOLDER_APECHAIN);

        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), amountIn);

        // Build route for algebra swap with command code 2 (user funds)
        bytes memory route = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: APE_ETH_HOLDER_APECHAIN,
                pool: ALGEBRA_POOL_APECHAIN,
                supportsFeeOnTransfer: true
            })
        );

        // Track initial balance
        uint256 beforeBalance = IERC20(WETH_TOKEN).balanceOf(
            APE_ETH_HOLDER_APECHAIN
        );

        // Execute the swap
        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            amountIn,
            WETH_TOKEN,
            0, // minOut = 0 for this test
            APE_ETH_HOLDER_APECHAIN,
            route
        );

        // Verify balances
        uint256 afterBalance = IERC20(WETH_TOKEN).balanceOf(
            APE_ETH_HOLDER_APECHAIN
        );
        assertGt(afterBalance - beforeBalance, 0, "Should receive some WETH");

        vm.stopPrank();
    }

    function test_CanSwap() public override {
        vm.startPrank(APE_ETH_HOLDER_APECHAIN);

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
                direction: SwapDirection.Token0ToToken1,
                supportsFeeOnTransfer: true
            })
        );

        vm.stopPrank();
    }

    function test_CanSwap_Reverse() public {
        test_CanSwap();

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: USER_SENDER,
                to: USER_SENDER,
                tokenIn: address(WETH_TOKEN),
                amountIn: 5 * 1e18,
                tokenOut: APE_ETH_TOKEN,
                direction: SwapDirection.Token1ToToken0,
                supportsFeeOnTransfer: false
            })
        );

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop_WithFeeOnTransferToken() public {
        MultiHopTestState memory state;
        state.isFeeOnTransfer = true;

        // Setup tokens and pools
        state = _setupTokensAndPools(state);

        // Execute and verify swap
        _executeAndVerifyMultiHopSwap(state);
    }

    function test_CanSwap_MultiHop() public override {
        MultiHopTestState memory state;
        state.isFeeOnTransfer = false;

        // Setup tokens and pools
        state = _setupTokensAndPools(state);

        // Execute and verify swap
        _executeAndVerifyMultiHopSwap(state);
    }

    // Test that the proper error is thrown when algebra swap fails
    function testRevert_SwapUnexpected() public {
        // Transfer tokens from whale to user
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Create invalid pool address
        address invalidPool = address(0x999);

        // Mock token0() call on invalid pool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(APE_ETH_TOKEN)
        );

        // Create a route with an invalid pool
        bytes memory invalidRoute = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: USER_SENDER,
                pool: invalidPool,
                supportsFeeOnTransfer: true
            })
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), 1 * 1e18);

        // Mock the algebra pool to not reset lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSelector(
                IAlgebraPool.swapSupportingFeeOnInputTokens.selector
            ),
            abi.encode(0, 0)
        );

        // Expect the AlgebraSwapUnexpected error
        vm.expectRevert(AlgebraSwapUnexpected.selector);

        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            1 * 1e18,
            address(WETH_TOKEN),
            0,
            USER_SENDER,
            invalidRoute
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    // Helper function to setup tokens and pools
    function _setupTokensAndPools(
        MultiHopTestState memory state
    ) private returns (MultiHopTestState memory) {
        // Create tokens
        ERC20 tokenA = new ERC20(
            "Token A",
            state.isFeeOnTransfer ? "FTA" : "TA",
            18
        );
        IERC20 tokenB;
        ERC20 tokenC = new ERC20(
            "Token C",
            state.isFeeOnTransfer ? "FTC" : "TC",
            18
        );

        if (state.isFeeOnTransfer) {
            tokenB = IERC20(
                address(
                    new MockFeeOnTransferToken("Fee Token B", "FTB", 18, 300)
                )
            );
        } else {
            tokenB = IERC20(address(new ERC20("Token B", "TB", 18)));
        }

        state.tokenA = IERC20(address(tokenA));
        state.tokenB = tokenB;
        state.tokenC = IERC20(address(tokenC));

        // Label addresses
        vm.label(address(state.tokenA), "Token A");
        vm.label(address(state.tokenB), "Token B");
        vm.label(address(state.tokenC), "Token C");

        // Mint initial token supplies
        tokenA.mint(address(this), 1_000_000 * 1e18);
        if (!state.isFeeOnTransfer) {
            ERC20(address(tokenB)).mint(address(this), 1_000_000 * 1e18);
        } else {
            MockFeeOnTransferToken(address(tokenB)).mint(
                address(this),
                1_000_000 * 1e18
            );
        }
        tokenC.mint(address(this), 1_000_000 * 1e18);

        // Create pools
        state.pool1 = _createAlgebraPool(
            address(state.tokenA),
            address(state.tokenB)
        );
        state.pool2 = _createAlgebraPool(
            address(state.tokenB),
            address(state.tokenC)
        );

        vm.label(state.pool1, "Pool 1");
        vm.label(state.pool2, "Pool 2");

        // Add liquidity
        _addLiquidityToPool(
            state.pool1,
            address(state.tokenA),
            address(state.tokenB)
        );
        _addLiquidityToPool(
            state.pool2,
            address(state.tokenB),
            address(state.tokenC)
        );

        state.amountToTransfer = 100 * 1e18;
        state.amountIn = 50 * 1e18;

        // Transfer tokens to USER_SENDER
        IERC20(address(state.tokenA)).transfer(
            USER_SENDER,
            state.amountToTransfer
        );

        return state;
    }

    // Helper function to execute and verify the swap
    function _executeAndVerifyMultiHopSwap(
        MultiHopTestState memory state
    ) private {
        vm.startPrank(USER_SENDER);

        uint256 initialBalanceA = IERC20(address(state.tokenA)).balanceOf(
            USER_SENDER
        );
        uint256 initialBalanceC = IERC20(address(state.tokenC)).balanceOf(
            USER_SENDER
        );

        // Approve spending
        IERC20(address(state.tokenA)).approve(
            address(liFiDEXAggregator),
            state.amountIn
        );

        // Build route
        bytes memory route = _buildMultiHopRouteForTest(state);

        // Execute swap
        liFiDEXAggregator.processRoute(
            address(state.tokenA),
            state.amountIn,
            address(state.tokenC),
            0, // No minimum amount out for testing
            USER_SENDER,
            route
        );

        // Verify results
        _verifyMultiHopResults(state, initialBalanceA, initialBalanceC);

        vm.stopPrank();
    }

    // Helper function to build the multi-hop route for test
    function _buildMultiHopRouteForTest(
        MultiHopTestState memory state
    ) private view returns (bytes memory) {
        bytes memory firstHop = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: address(state.tokenA),
                recipient: address(liFiDEXAggregator),
                pool: state.pool1,
                supportsFeeOnTransfer: false
            })
        );

        bytes memory secondHop = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessMyERC20,
                tokenIn: address(state.tokenB),
                recipient: USER_SENDER,
                pool: state.pool2,
                supportsFeeOnTransfer: state.isFeeOnTransfer
            })
        );

        return bytes.concat(firstHop, secondHop);
    }

    // Helper function to verify multi-hop results
    function _verifyMultiHopResults(
        MultiHopTestState memory state,
        uint256 initialBalanceA,
        uint256 initialBalanceC
    ) private {
        uint256 finalBalanceA = IERC20(address(state.tokenA)).balanceOf(
            USER_SENDER
        );
        uint256 finalBalanceC = IERC20(address(state.tokenC)).balanceOf(
            USER_SENDER
        );

        assertApproxEqAbs(
            initialBalanceA - finalBalanceA,
            state.amountIn,
            1, // 1 wei tolerance
            "TokenA spent amount mismatch"
        );
        assertGt(finalBalanceC, initialBalanceC, "TokenC not received");

        emit log_named_uint(
            state.isFeeOnTransfer
                ? "Output amount with fee tokens"
                : "Output amount with regular tokens",
            finalBalanceC - initialBalanceC
        );
    }

    // Helper function to create an Algebra pool
    function _createAlgebraPool(
        address tokenA,
        address tokenB
    ) internal returns (address pool) {
        // Call the actual Algebra factory to create a pool
        pool = IAlgebraFactory(ALGEBRA_FACTORY_APECHAIN).createPool(
            tokenA,
            tokenB
        );
        return pool;
    }

    // Helper function to add liquidity to a pool
    function _addLiquidityToPool(
        address pool,
        address token0,
        address token1
    ) internal {
        // For fee-on-transfer tokens, we need to send more  to account for the fee
        // We'll use a small amount and send extra to cover fees
        uint256 initialAmount0 = 1e17; // 0.1 token
        uint256 initialAmount1 = 1e17; // 0.1 token

        // Send extra for fee-on-transfer tokens (10% extra should be enough for our test tokens with 5% fee)
        uint256 transferAmount0 = (initialAmount0 * 110) / 100;
        uint256 transferAmount1 = (initialAmount1 * 110) / 100;

        // Initialize with 1:1 price ratio (Q64.96 format)
        uint160 initialPrice = uint160(1 << 96);
        IAlgebraPool(pool).initialize(initialPrice);

        // Create AlgebraLiquidityAdderHelper with safe transfer logic
        AlgebraLiquidityAdderHelper algebraLiquidityAdderHelper = new AlgebraLiquidityAdderHelper(
                token0,
                token1
            );

        // Transfer tokens with extra amounts to account for fees
        IERC20(token0).transfer(
            address(algebraLiquidityAdderHelper),
            transferAmount0
        );
        IERC20(token1).transfer(
            address(algebraLiquidityAdderHelper),
            transferAmount1
        );

        // Get actual balances to use for liquidity, accounting for any fees
        uint256 actualBalance0 = IERC20(token0).balanceOf(
            address(algebraLiquidityAdderHelper)
        );
        uint256 actualBalance1 = IERC20(token1).balanceOf(
            address(algebraLiquidityAdderHelper)
        );

        // Use the smaller of the two balances for liquidity amount
        uint128 liquidityAmount = uint128(
            actualBalance0 < actualBalance1 ? actualBalance0 : actualBalance1
        );

        // Add liquidity using the actual token amounts we have
        algebraLiquidityAdderHelper.addLiquidity(
            pool,
            -887220,
            887220,
            liquidityAmount / 2 // Use half of available liquidity to ensure success
        );
    }

    struct MultiHopTestState {
        IERC20 tokenA;
        IERC20 tokenB; // Can be either regular ERC20 or MockFeeOnTransferToken
        IERC20 tokenC;
        address pool1;
        address pool2;
        uint256 amountIn;
        uint256 amountToTransfer;
        bool isFeeOnTransfer;
    }

    struct AlgebraRouteParams {
        CommandType commandCode; // 1 for contract funds, 2 for user funds
        address tokenIn; // Input token address
        address recipient; // Address receiving the output tokens
        address pool; // Algebra pool address
        bool supportsFeeOnTransfer; // Whether to support fee-on-transfer tokens
    }

    // Helper function to build route for Apechain Algebra swap
    function _buildAlgebraRoute(
        AlgebraRouteParams memory params
    ) internal view returns (bytes memory route) {
        address token0 = IAlgebraPool(params.pool).token0();
        bool zeroForOne = (params.tokenIn == token0);
        SwapDirection direction = zeroForOne
            ? SwapDirection.Token0ToToken1
            : SwapDirection.Token1ToToken0;

        route = abi.encodePacked(
            params.commandCode,
            params.tokenIn,
            uint8(1), // one pool
            FULL_SHARE, // 100% share
            uint8(PoolType.Algebra),
            params.pool,
            uint8(direction),
            params.recipient,
            params.supportsFeeOnTransfer ? uint8(1) : uint8(0)
        );

        return route;
    }

    // Helper function to test an Algebra swap
    function _testAlgebraSwap(AlgebraSwapTestParams memory params) internal {
        // Find or create a pool
        address pool = _getPool(params.tokenIn, params.tokenOut);

        vm.label(pool, "AlgebraPool");

        // Get token0 from pool and label tokens accordingly
        address token0 = IAlgebraPool(pool).token0();
        if (params.tokenIn == token0) {
            vm.label(
                params.tokenIn,
                string.concat("token0 (", ERC20(params.tokenIn).symbol(), ")")
            );
            vm.label(
                params.tokenOut,
                string.concat("token1 (", ERC20(params.tokenOut).symbol(), ")")
            );
        } else {
            vm.label(
                params.tokenIn,
                string.concat("token1 (", ERC20(params.tokenIn).symbol(), ")")
            );
            vm.label(
                params.tokenOut,
                string.concat("token0 (", ERC20(params.tokenOut).symbol(), ")")
            );
        }

        // Record initial balances
        uint256 initialTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 initialTokenOut = IERC20(params.tokenOut).balanceOf(params.to);

        // Get expected output from QuoterV2
        // NOTE: There may be a small discrepancy between the quoted amount and the actual output
        // because the Quoter uses the regular swap() function for simulation while the actual
        // execution may use swapSupportingFeeOnInputTokens() for fee-on-transfer tokens.
        // The Quoter cannot accurately predict transfer fees taken by the token contract itself,
        // resulting in minor "dust" differences that are normal and expected when dealing with
        // non-standard token implementations.
        uint256 expectedOutput = _getQuoteExactInput(
            params.tokenIn,
            params.tokenOut,
            params.amountIn
        );

        // Build the route
        CommandType commandCode = params.from == address(liFiDEXAggregator)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;
        bytes memory route = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: commandCode,
                tokenIn: params.tokenIn,
                recipient: params.to,
                pool: pool,
                supportsFeeOnTransfer: params.supportsFeeOnTransfer
            })
        );

        // Approve tokens
        IERC20(params.tokenIn).approve(
            address(liFiDEXAggregator),
            params.amountIn
        );

        // Execute the swap
        address from = params.from == address(liFiDEXAggregator)
            ? USER_SENDER
            : params.from;

        vm.expectEmit(true, true, true, false);
        emit Route(
            from,
            params.to,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            expectedOutput,
            expectedOutput
        );

        uint256 minOut = (expectedOutput * 995) / 1000; // 0.5% slippage

        liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            minOut,
            params.to,
            route
        );

        uint256 finalTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 finalTokenOut = IERC20(params.tokenOut).balanceOf(params.to);

        assertApproxEqAbs(
            initialTokenIn - finalTokenIn,
            params.amountIn,
            1, // 1 wei tolerance
            "TokenIn amount mismatch"
        );
        assertGt(finalTokenOut, initialTokenOut, "TokenOut not received");
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

    function _getQuoteExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private returns (uint256 amountOut) {
        (amountOut, ) = IAlgebraQuoter(ALGEBRA_QUOTER_V2_APECHAIN)
            .quoteExactInputSingle(tokenIn, tokenOut, amountIn, 0);
        return amountOut;
    }

    function testRevert_AlgebraSwap_ZeroAddressPool() public {
        // Transfer tokens from whale to user
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Mock token0() call on address(0)
        vm.mockCall(
            address(0),
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(APE_ETH_TOKEN)
        );

        // Build route with address(0) as pool
        bytes memory route = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: USER_SENDER,
                pool: address(0), // Zero address pool
                supportsFeeOnTransfer: true
            })
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), 1 * 1e18);

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);

        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            1 * 1e18,
            address(WETH_TOKEN),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function testRevert_AlgebraSwap_ImpossiblePoolAddress() public {
        // Transfer tokens from whale to user
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Mock token0() call on IMPOSSIBLE_POOL_ADDRESS
        vm.mockCall(
            IMPOSSIBLE_POOL_ADDRESS,
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(APE_ETH_TOKEN)
        );

        // Build route with IMPOSSIBLE_POOL_ADDRESS as pool
        bytes memory route = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: USER_SENDER,
                pool: IMPOSSIBLE_POOL_ADDRESS, // Impossible pool address
                supportsFeeOnTransfer: true
            })
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), 1 * 1e18);

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);

        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            1 * 1e18,
            address(WETH_TOKEN),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function testRevert_AlgebraSwap_ZeroAddressRecipient() public {
        // Transfer tokens from whale to user
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Mock token0() call on the pool
        vm.mockCall(
            ALGEBRA_POOL_APECHAIN,
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(APE_ETH_TOKEN)
        );

        // Build route with address(0) as recipient
        bytes memory route = _buildAlgebraRoute(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: address(0), // Zero address recipient
                pool: ALGEBRA_POOL_APECHAIN,
                supportsFeeOnTransfer: true
            })
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(liFiDEXAggregator), 1 * 1e18);

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);

        liFiDEXAggregator.processRoute(
            APE_ETH_TOKEN,
            1 * 1e18,
            address(WETH_TOKEN),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }
}

/**
 * @title LiFiDexAggregatorIzumiV3Test
 * @notice Tests specific to iZiSwap V3 pool type
 */
contract LiFiDexAggregatorIzumiV3Test is LiFiDexAggregatorTest {
    // ==================== iZiSwap V3 specific variables ====================
    // Base constants
    address internal constant USDC =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH =
        0x4200000000000000000000000000000000000006;
    address internal constant USDB_C =
        0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;

    // iZiSwap pools
    address internal constant IZUMI_WETH_USDC_POOL =
        0xb92A9A91a9F7E8e6Bb848508A6DaF08f9D718554;
    address internal constant IZUMI_WETH_USDB_C_POOL =
        0xdb5D62f06EEcEf0Da7506e0700c2f03c57016De5;

    // Test parameters
    uint256 internal constant AMOUNT_USDC = 100 * 1e6; // 100 USDC with 6 decimals
    uint256 internal constant AMOUNT_WETH = 1 * 1e18; // 1 WETH with 18 decimals

    // structs
    struct IzumiV3SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        SwapDirection direction;
    }

    struct MultiHopTestParams {
        address tokenIn;
        address tokenMid;
        address tokenOut;
        address pool1;
        address pool2;
        uint256 amountIn;
        SwapDirection direction1;
        SwapDirection direction2;
    }

    error IzumiV3SwapUnexpected();
    error IzumiV3SwapCallbackUnknownSource();
    error IzumiV3SwapCallbackNotPositiveAmount();

    function setUp() public override {
        super.setUp();

        string memory baseRpc = vm.envString("ETH_NODE_URI_BASE");
        vm.createSelectFork(baseRpc, 29831758);

        _initializeDexAggregator(USER_DIAMOND_OWNER);

        // Setup labels
        vm.label(address(liFiDEXAggregator), "LiFiDEXAggregator");
        vm.label(USDC, "USDC");
        vm.label(WETH, "WETH");
        vm.label(USDB_C, "USDB-C");
        vm.label(IZUMI_WETH_USDC_POOL, "WETH-USDC Pool");
        vm.label(IZUMI_WETH_USDB_C_POOL, "WETH-USDB-C Pool");
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Test USDC -> WETH
        deal(USDC, address(liFiDEXAggregator), AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        _testSwap(
            IzumiV3SwapTestParams({
                from: address(liFiDEXAggregator),
                to: USER_SENDER,
                tokenIn: USDC,
                amountIn: AMOUNT_USDC,
                tokenOut: WETH,
                direction: SwapDirection.Token1ToToken0
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        _testMultiHopSwap(
            MultiHopTestParams({
                tokenIn: USDC,
                tokenMid: WETH,
                tokenOut: USDB_C,
                pool1: IZUMI_WETH_USDC_POOL,
                pool2: IZUMI_WETH_USDB_C_POOL,
                amountIn: AMOUNT_USDC,
                direction1: SwapDirection.Token1ToToken0,
                direction2: SwapDirection.Token0ToToken1
            })
        );
    }

    function test_CanSwap() public override {
        deal(address(USDC), USER_SENDER, AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        IERC20(USDC).approve(address(liFiDEXAggregator), AMOUNT_USDC);

        // fix the swap data encoding
        bytes memory swapData = _buildIzumiV3Route(
            CommandType.ProcessUserERC20,
            USDC,
            uint8(SwapDirection.Token1ToToken0),
            IZUMI_WETH_USDC_POOL,
            USER_RECEIVER
        );

        vm.expectEmit(true, true, true, false);
        emit Route(USER_SENDER, USER_RECEIVER, USDC, WETH, AMOUNT_USDC, 0, 0);

        liFiDEXAggregator.processRoute(
            USDC,
            AMOUNT_USDC,
            WETH,
            0,
            USER_RECEIVER,
            swapData
        );

        vm.stopPrank();
    }

    function testRevert_IzumiV3SwapUnexpected() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        vm.startPrank(USER_SENDER);

        // create invalid pool address
        address invalidPool = address(0x999);

        // create a route with an invalid pool
        bytes memory invalidRoute = _buildIzumiV3Route(
            CommandType.ProcessUserERC20,
            USDC,
            uint8(SwapDirection.Token1ToToken0),
            invalidPool,
            USER_SENDER
        );

        IERC20(USDC).approve(address(liFiDEXAggregator), AMOUNT_USDC);

        // mock the iZiSwap pool to return without updating lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSignature("swapY2X(address,uint128,int24,bytes)"),
            abi.encode(0, 0) // return amountX and amountY without triggering callback or updating lastCalledPool
        );

        vm.expectRevert(IzumiV3SwapUnexpected.selector);

        liFiDEXAggregator.processRoute(
            USDC,
            AMOUNT_USDC,
            WETH,
            0,
            USER_SENDER,
            invalidRoute
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function testRevert_IzumiV3SwapCallbackUnknownSource() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        // create invalid pool address
        address invalidPool = address(0x999);

        vm.prank(USER_SENDER);
        IERC20(USDC).approve(address(liFiDEXAggregator), AMOUNT_USDC);

        // mock the pool to call the callback directly without setting lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSignature("swapY2X(address,uint128,int24,bytes)"),
            abi.encode(0, 0)
        );

        // try to call the callback directly from the pool without setting lastCalledPool
        vm.prank(invalidPool);
        vm.expectRevert(IzumiV3SwapCallbackUnknownSource.selector);
        liFiDEXAggregator.swapY2XCallback(0, AMOUNT_USDC, abi.encode(USDC));

        vm.clearMockedCalls();
    }

    function testRevert_IzumiV3SwapCallbackNotPositiveAmount() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        // set lastCalledPool to the pool address to pass the unknown source check
        vm.store(
            address(liFiDEXAggregator),
            bytes32(uint256(3)), // slot for lastCalledPool
            bytes32(uint256(uint160(IZUMI_WETH_USDC_POOL)))
        );

        // try to call the callback with zero amount
        vm.prank(IZUMI_WETH_USDC_POOL);
        vm.expectRevert(IzumiV3SwapCallbackNotPositiveAmount.selector);
        liFiDEXAggregator.swapY2XCallback(
            0,
            0, // zero amount should trigger the error
            abi.encode(USDC)
        );
    }

    function _testSwap(IzumiV3SwapTestParams memory params) internal {
        // Fund the sender with tokens if not the contract itself
        if (params.from != address(liFiDEXAggregator)) {
            deal(params.tokenIn, params.from, params.amountIn);
        }

        // Capture initial token balances
        uint256 initialBalanceIn = IERC20(params.tokenIn).balanceOf(
            params.from
        );
        uint256 initialBalanceOut = IERC20(params.tokenOut).balanceOf(
            params.to
        );

        // Build the route based on the command type
        CommandType commandCode = params.from == address(liFiDEXAggregator)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;

        // Construct the route
        bytes memory route = _buildIzumiV3Route(
            commandCode,
            params.tokenIn,
            uint8(params.direction == SwapDirection.Token0ToToken1 ? 1 : 0),
            IZUMI_WETH_USDC_POOL,
            params.to
        );

        // Approve tokens if necessary
        if (params.from == USER_SENDER) {
            vm.startPrank(USER_SENDER);
            IERC20(params.tokenIn).approve(
                address(liFiDEXAggregator),
                params.amountIn
            );
        }

        // Expect the Route event emission
        address from = params.from == address(liFiDEXAggregator)
            ? USER_SENDER
            : params.from;

        vm.expectEmit(true, true, true, false);
        emit Route(
            from,
            params.to,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            0, // No minimum amount enforced in test
            0 // Actual amount will be checked after the swap
        );

        // Execute the swap
        uint256 amountOut = liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            0, // No minimum amount for testing
            params.to,
            route
        );

        if (params.from == USER_SENDER) {
            vm.stopPrank();
        }

        // Verify balances have changed correctly
        uint256 finalBalanceIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 finalBalanceOut = IERC20(params.tokenOut).balanceOf(params.to);

        assertApproxEqAbs(
            initialBalanceIn - finalBalanceIn,
            params.amountIn,
            1, // 1 wei tolerance because of undrain protection for dex aggregator
            "TokenIn amount mismatch"
        );
        assertGt(finalBalanceOut, initialBalanceOut, "TokenOut not received");
        assertEq(
            amountOut,
            finalBalanceOut - initialBalanceOut,
            "AmountOut mismatch"
        );

        emit log_named_uint("Amount In", params.amountIn);
        emit log_named_uint("Amount Out", amountOut);
    }

    function _testMultiHopSwap(MultiHopTestParams memory params) internal {
        // Fund the sender with tokens
        deal(params.tokenIn, USER_SENDER, params.amountIn);

        // Capture initial token balances
        uint256 initialBalanceIn;
        uint256 initialBalanceOut;

        initialBalanceIn = IERC20(params.tokenIn).balanceOf(USER_SENDER);
        initialBalanceOut = IERC20(params.tokenOut).balanceOf(USER_SENDER);

        // Build multi-hop route
        bytes memory route = _buildIzumiV3MultiHopRoute(params);

        // Approve tokens
        vm.startPrank(USER_SENDER);
        IERC20(params.tokenIn).approve(
            address(liFiDEXAggregator),
            params.amountIn
        );

        // Execute the swap
        uint256 amountOut = liFiDEXAggregator.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            0, // No minimum amount for testing
            USER_SENDER,
            route
        );
        vm.stopPrank();

        // Verify balances have changed correctly
        uint256 finalBalanceIn;
        uint256 finalBalanceOut;

        finalBalanceIn = IERC20(params.tokenIn).balanceOf(USER_SENDER);
        finalBalanceOut = IERC20(params.tokenOut).balanceOf(USER_SENDER);

        assertEq(
            initialBalanceIn - finalBalanceIn,
            params.amountIn,
            "TokenIn amount mismatch"
        );
        assertGt(finalBalanceOut, initialBalanceOut, "TokenOut not received");
        assertEq(
            amountOut,
            finalBalanceOut - initialBalanceOut,
            "AmountOut mismatch"
        );
    }

    function _buildIzumiV3Route(
        CommandType commandCode,
        address tokenIn,
        uint8 direction,
        address pool,
        address recipient
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(commandCode),
                tokenIn,
                uint8(1), // number of pools (1)
                FULL_SHARE, // 100% share
                uint8(PoolType.iZiSwap), // pool type
                pool,
                uint8(direction),
                recipient
            );
    }

    function _buildIzumiV3MultiHopRoute(
        MultiHopTestParams memory params
    ) internal view returns (bytes memory) {
        // First hop: USER_ERC20 -> LDA
        bytes memory firstHop = _buildIzumiV3Route(
            CommandType.ProcessUserERC20,
            params.tokenIn,
            uint8(params.direction1),
            params.pool1,
            address(liFiDEXAggregator)
        );

        // Second hop: MY_ERC20 (LDA) -> pool2
        bytes memory secondHop = _buildIzumiV3Route(
            CommandType.ProcessMyERC20,
            params.tokenMid,
            uint8(params.direction2),
            params.pool2,
            USER_SENDER // final recipient
        );

        // Combine the two hops
        return bytes.concat(firstHop, secondHop);
    }
}

// -----------------------------------------------------------------------------
//  HyperswapV3 on HyperEVM
// -----------------------------------------------------------------------------
contract LiFiDexAggregatorHyperswapV3Test is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    /// @dev HyperswapV3 router on HyperEVM chain
    IHyperswapV3Factory internal constant HYPERSWAP_FACTORY =
        IHyperswapV3Factory(0xB1c0fa0B789320044A6F623cFe5eBda9562602E3);
    /// @dev HyperswapV3 quoter on HyperEVM chain
    IHyperswapV3QuoterV2 internal constant HYPERSWAP_QUOTER =
        IHyperswapV3QuoterV2(0x03A918028f22D9E1473B7959C927AD7425A45C7C);

    /// @dev a liquid USDT on HyperEVM
    IERC20 internal constant USDT0 =
        IERC20(0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb);
    /// @dev WHYPE on HyperEVM
    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);

    struct HyperswapV3Params {
        CommandType commandCode; // ProcessMyERC20 or ProcessUserERC20
        address tokenIn; // Input token address
        address recipient; // Address receiving the output tokens
        address pool; // HyperswapV3 pool address
        bool zeroForOne; // Direction of the swap
    }

    function setUp() public override {
        setupHyperEVM();
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e6; // 1000 USDT0

        deal(address(USDT0), USER_SENDER, amountIn);

        // user approves
        vm.prank(USER_SENDER);
        USDT0.approve(address(liFiDEXAggregator), amountIn);

        // fetch the real pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(USDT0),
            address(WHYPE),
            3000
        );

        // Create the params struct for quoting
        IHyperswapV3QuoterV2.QuoteExactInputSingleParams
            memory params = IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
                tokenIn: address(USDT0),
                tokenOut: address(WHYPE),
                amountIn: amountIn,
                fee: 3000,
                sqrtPriceLimitX96: 0
            });

        // Get the quote using the struct
        (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
            params
        );

        // build the "off-chain" route
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(USDT0),
            uint8(1), // 1 pool
            uint16(65535), // FULL_SHARE
            uint8(1), // POOL_TYPE_UNIV3
            pool,
            uint8(0), // zeroForOne = true if USDT0 < WHYPE
            address(USER_SENDER)
        );

        // expect the Route event
        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            address(USDT0),
            address(WHYPE),
            amountIn,
            quoted,
            quoted
        );

        // execute
        vm.prank(USER_SENDER);
        liFiDEXAggregator.processRoute(
            address(USDT0),
            amountIn,
            address(WHYPE),
            quoted,
            USER_SENDER,
            route
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 1_000 * 1e6; // 1000 USDT0

        // Fund dex aggregator contract
        deal(address(USDT0), address(liFiDEXAggregator), amountIn);

        // fetch the real pool and quote
        address pool = HYPERSWAP_FACTORY.getPool(
            address(USDT0),
            address(WHYPE),
            3000
        );

        // Create the params struct for quoting
        IHyperswapV3QuoterV2.QuoteExactInputSingleParams
            memory params = IHyperswapV3QuoterV2.QuoteExactInputSingleParams({
                tokenIn: address(USDT0),
                tokenOut: address(WHYPE),
                amountIn: amountIn - 1, // Subtract 1 to match slot undrain protection
                fee: 3000,
                sqrtPriceLimitX96: 0
            });

        // Get the quote using the struct
        (uint256 quoted, , , ) = HYPERSWAP_QUOTER.quoteExactInputSingle(
            params
        );

        // Build route using our helper function
        bytes memory route = _buildHyperswapV3Route(
            HyperswapV3Params({
                commandCode: CommandType.ProcessMyERC20,
                tokenIn: address(USDT0),
                recipient: USER_SENDER,
                pool: pool,
                zeroForOne: true // USDT0 < WHYPE
            })
        );

        // expect the Route event
        vm.expectEmit(true, true, true, true);
        emit Route(
            USER_SENDER,
            USER_SENDER,
            address(USDT0),
            address(WHYPE),
            amountIn - 1, // Account for slot undrain protection
            quoted,
            quoted
        );

        // execute
        vm.prank(USER_SENDER);
        liFiDEXAggregator.processRoute(
            address(USDT0),
            amountIn - 1, // Account for slot undrain protection
            address(WHYPE),
            quoted,
            USER_SENDER,
            route
        );
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: HyperswapV3 multi-hop unsupported due to AS requirement.
        // HyperswapV3 does not support a "one-pool" second hop today, because
        // the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. HyperswapV3's swap() immediately reverts on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }

    function _buildHyperswapV3Route(
        HyperswapV3Params memory params
    ) internal pure returns (bytes memory route) {
        route = abi.encodePacked(
            uint8(params.commandCode),
            params.tokenIn,
            uint8(1), // 1 pool
            FULL_SHARE, // 65535 - 100% share
            uint8(PoolType.UniV3), // POOL_TYPE_UNIV3 = 1
            params.pool,
            uint8(params.zeroForOne ? 0 : 1), // Convert bool to uint8: 0 for true, 1 for false
            params.recipient
        );

        return route;
    }
}

// -----------------------------------------------------------------------------
//  LaminarV3 on HyperEVM
// -----------------------------------------------------------------------------
contract LiFiDexAggregatorLaminarV3Test is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);
    IERC20 internal constant LHYPE =
        IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562);

    address internal constant WHYPE_LHYPE_POOL =
        0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45;

    function setUp() public override {
        setupHyperEVM();
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e18;

        // Fund the user with WHYPE
        deal(address(WHYPE), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WHYPE.approve(address(liFiDEXAggregator), amountIn);

        // Build a single-pool UniV3 route
        bool zeroForOne = address(WHYPE) > address(LHYPE);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(WHYPE),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.UniV3),
            WHYPE_LHYPE_POOL,
            uint8(zeroForOne ? 0 : 1),
            address(USER_SENDER)
        );

        // Record balances
        uint256 inBefore = WHYPE.balanceOf(USER_SENDER);
        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Execute swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
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
        deal(address(WHYPE), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);

        bool zeroForOne = address(WHYPE) > address(LHYPE);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(WHYPE),
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.UniV3),
            WHYPE_LHYPE_POOL,
            uint8(zeroForOne ? 0 : 1),
            address(USER_SENDER)
        );

        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Withdraw 1 wei to avoid slot-undrain protection
        liFiDEXAggregator.processRoute(
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

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: Laminar V3 multi-hop unsupported due to AS requirement.
        // Laminar V3 does not support a "one-pool" second hop today, because
        // the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. Laminar V3's swap() immediately reverts on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }
}

contract LiFiDexAggregatorXSwapV3Test is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    address internal constant USDC_E_WXDC_POOL =
        0x81B4afF811E94fb084A0d3B3ca456D09AeC14EB0;

    /// @dev our two tokens: USDC.e and wrapped XDC
    IERC20 internal constant USDC_E =
        IERC20(0x2A8E898b6242355c290E1f4Fc966b8788729A4D4);
    IERC20 internal constant WXDC =
        IERC20(0x951857744785E80e2De051c32EE7b25f9c458C42);

    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_XDC";
        customBlockNumberForForking = 89279495;
        fork();

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e6;
        deal(address(USDC_E), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        USDC_E.approve(address(liFiDEXAggregator), amountIn);

        // Build a one-pool V3 route
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(USDC_E),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.UniV3),
            USDC_E_WXDC_POOL,
            uint8(1), // zeroForOne (USDC.e > WXDC)
            USER_SENDER
        );

        // Record balances before swap
        uint256 inBefore = USDC_E.balanceOf(USER_SENDER);
        uint256 outBefore = WXDC.balanceOf(USER_SENDER);

        // Execute swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
            address(USDC_E),
            amountIn,
            address(WXDC),
            0,
            USER_SENDER,
            route
        );

        // Verify balances after swap
        uint256 inAfter = USDC_E.balanceOf(USER_SENDER);
        uint256 outAfter = WXDC.balanceOf(USER_SENDER);
        assertEq(inBefore - inAfter, amountIn, "USDC.e spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive WXDC");

        vm.stopPrank();
    }

    /// @notice single-pool swap: aggregator contract sends USDC.e → user receives WXDC
    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 5_000 * 1e6;

        // fund the aggregator
        deal(address(USDC_E), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);

        // Account for slot-undrain protection
        uint256 swapAmount = amountIn - 1;

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(USDC_E),
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.UniV3),
            USDC_E_WXDC_POOL,
            uint8(1), // zeroForOne (USDC.e > WXDC)
            USER_SENDER
        );

        // Record balances before swap
        uint256 outBefore = WXDC.balanceOf(USER_SENDER);

        liFiDEXAggregator.processRoute(
            address(USDC_E),
            swapAmount,
            address(WXDC),
            0,
            USER_SENDER,
            route
        );

        // Verify balances after swap
        uint256 outAfter = WXDC.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive WXDC");

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: XSwap V3 multi-hop unsupported due to AS requirement.
        // XSwap V3 does not support a "one-pool" second hop today, because
        // the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. XSwap V3's swap() immediately reverts on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }
}

// -----------------------------------------------------------------------------
//  RabbitSwap on Viction
// -----------------------------------------------------------------------------
contract LiFiDexAggregatorRabbitSwapTest is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    // Constants for RabbitSwap on Viction
    IERC20 internal constant SOROS =
        IERC20(0xB786D9c8120D311b948cF1e5Aa48D8fBacf477E2);
    IERC20 internal constant C98 =
        IERC20(0x0Fd0288AAAE91eaF935e2eC14b23486f86516c8C);
    address internal constant SOROS_C98_POOL =
        0xF10eFaE2DdAC396c4ef3c52009dB429A120d0C0D;

    function setUp() public override {
        // setup for Viction network
        customRpcUrlForForking = "ETH_NODE_URI_VICTION";
        customBlockNumberForForking = 94490946;
        fork();

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e18;

        // fund the user with SOROS
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(liFiDEXAggregator), amountIn);

        // build a single-pool UniV3-style route
        bool zeroForOne = address(SOROS) > address(C98);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.UniV3), // RabbitSwap uses UniV3 pool type
            SOROS_C98_POOL,
            uint8(zeroForOne ? 0 : 1),
            address(USER_SENDER)
        );

        // record balances before swap
        uint256 inBefore = SOROS.balanceOf(USER_SENDER);
        uint256 outBefore = C98.balanceOf(USER_SENDER);

        // execute swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        // verify balances after swap
        uint256 inAfter = SOROS.balanceOf(USER_SENDER);
        uint256 outAfter = C98.balanceOf(USER_SENDER);
        assertEq(inBefore - inAfter, amountIn, "SOROS spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive C98");

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        uint256 amountIn = 1_000 * 1e18;

        // fund the aggregator directly
        deal(address(SOROS), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);

        bool zeroForOne = address(SOROS) > address(C98);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.UniV3),
            SOROS_C98_POOL,
            uint8(zeroForOne ? 0 : 1),
            address(USER_SENDER)
        );

        uint256 outBefore = C98.balanceOf(USER_SENDER);

        // withdraw 1 wei less to avoid slot-undrain protection
        liFiDEXAggregator.processRoute(
            address(SOROS),
            amountIn - 1,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        uint256 outAfter = C98.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive C98");

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: RabbitSwap multi-hop unsupported due to AS requirement.
        // RabbitSwap (being a UniV3 fork) does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }

    function testRevert_RabbitSwapInvalidPool() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(liFiDEXAggregator), amountIn);

        // build route with invalid pool address
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.UniV3),
            address(0), // invalid pool address
            uint8(0),
            USER_SENDER
        );

        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
    }

    function testRevert_RabbitSwapInvalidRecipient() public {
        uint256 amountIn = 1_000 * 1e18;
        deal(address(SOROS), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        SOROS.approve(address(liFiDEXAggregator), amountIn);

        // build route with invalid recipient
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(SOROS),
            uint8(1),
            FULL_SHARE,
            uint8(PoolType.UniV3),
            SOROS_C98_POOL,
            uint8(0),
            address(0) // invalid recipient
        );

        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            address(SOROS),
            amountIn,
            address(C98),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
    }
}

// ----------------------------------------------
// EnosysDexV3 on Flare
// ----------------------------------------------
contract LiFiDexAggregatorEnosysDexV3Test is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    /// @dev HLN token on Flare
    IERC20 internal constant HLN =
        IERC20(0x140D8d3649Ec605CF69018C627fB44cCC76eC89f);

    /// @dev USDT0 token on Flare
    IERC20 internal constant USDT0 =
        IERC20(0xe7cd86e13AC4309349F30B3435a9d337750fC82D);

    /// @dev The single EnosysDexV3 pool for HLN–USDT0
    address internal constant ENOSYS_V3_POOL =
        0xA7C9E7343bD8f1eb7000F25dE5aeb52c6B78B1b7;

    /// @notice Set up a fork of Flare at block 42652369 and initialize the aggregator
    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_FLARE";
        customBlockNumberForForking = 42652369;
        fork();

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    /// @notice Single‐pool swap: USER sends HLN → receives USDT0
    function test_CanSwap() public override {
        // Mint 1 000 HLN to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(HLN), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        HLN.approve(address(liFiDEXAggregator), amountIn);

        bool zeroForOne = address(HLN) > address(USDT0);

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(HLN), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.UniV3), // V3‐style pool
            ENOSYS_V3_POOL, // pool address
            uint8(zeroForOne ? 0 : 1), // 0 = token0→token1, 1 = token1→token0
            address(USER_SENDER) // recipient
        );

        // Record balances before swap
        uint256 inBefore = HLN.balanceOf(USER_SENDER);
        uint256 outBefore = USDT0.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
            address(HLN),
            amountIn,
            address(USDT0),
            0,
            USER_SENDER,
            route
        );

        // Verify that HLN was spent and some USDT0 was received
        uint256 inAfter = HLN.balanceOf(USER_SENDER);
        uint256 outAfter = USDT0.balanceOf(USER_SENDER);

        assertEq(inBefore - inAfter, amountIn, "HLN spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive USDT0");

        vm.stopPrank();
    }

    /// @notice Single‐pool swap: aggregator holds HLN → user receives USDT0
    function test_CanSwap_FromDexAggregator() public override {
        // Fund the aggregator with 1 000 HLN
        uint256 amountIn = 1_000 * 1e18;
        deal(address(HLN), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);
        bool zeroForOne = address(HLN) > address(USDT0);

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20), // aggregator's funds
            address(HLN), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.UniV3), // V3‐style pool
            ENOSYS_V3_POOL, // pool address
            uint8(zeroForOne ? 0 : 1), // 0 = token0→token1
            address(USER_SENDER) // recipient
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDT0.balanceOf(USER_SENDER);

        liFiDEXAggregator.processRoute(
            address(HLN),
            swapAmount,
            address(USDT0),
            0,
            USER_SENDER,
            route
        );

        // Verify that some USDT0 was received
        uint256 outAfter = USDT0.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive USDT0");

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        // SKIPPED: EnosysDexV3 multi-hop unsupported due to AS requirement.
        // EnosysDexV3 (being a UniV3 fork) does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools
        // in a single processRoute invocation.
    }
}

// ----------------------------------------------
// SyncSwapV2 on Linea
// ----------------------------------------------
contract LiFiDexAggregatorSyncSwapV2Test is LiFiDexAggregatorTest {
    using SafeERC20 for IERC20;

    // address internal constant SYNC_SWAP_V3_ROUTER = address(0x2c81dF4F11A1C7E43Acb972e73767B1f5d0d9edc);
    IERC20 internal constant USDC =
        IERC20(0x176211869cA2b568f2A7D4EE941E073a821EE1ff);
    IERC20 internal constant WETH =
        IERC20(0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f);
    address internal constant USDC_WETH_POOL_V1 =
        address(0x5Ec5b1E9b1Bd5198343ABB6E55Fb695d2F7Bb308);
    address internal constant SYNC_SWAP_VAULT =
        address(0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B);

    address internal constant USDC_WETH_POOL_V2 =
        address(0xDDed227D71A096c6B5D87807C1B5C456771aAA94);

    IERC20 internal constant USDT =
        IERC20(0xA219439258ca9da29E9Cc4cE5596924745e12B93);
    address internal constant USDC_USDT_POOL_V1 =
        address(0x258d5f860B11ec73Ee200eB14f1b60A3B7A536a2);

    /// @notice Set up a fork of Linea at block 20077881 and initialize the aggregator
    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_LINEA";
        customBlockNumberForForking = 20077881;
        fork();

        _initializeDexAggregator(USER_DIAMOND_OWNER);
    }

    /// @notice Single‐pool swap: USER sends WETH → receives USDC
    function test_CanSwap() public override {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(liFiDEXAggregator), amountIn);

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V1, // pool address
            address(USER_SENDER), // recipient
            uint8(2), // withdrawMode
            uint8(1), // isV1Pool
            address(SYNC_SWAP_VAULT) // vault
        );

        // Record balances before swap
        uint256 inBefore = WETH.balanceOf(USER_SENDER);
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            route
        );

        // Verify that WETH was spent and some USDC_C was received
        uint256 inAfter = WETH.balanceOf(USER_SENDER);
        uint256 outAfter = USDC.balanceOf(USER_SENDER);

        assertEq(inBefore - inAfter, amountIn, "WETH spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive USDC");

        vm.stopPrank();
    }

    function test_CanSwap_PoolV2() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(liFiDEXAggregator), amountIn);

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V2, // pool address
            address(USER_SENDER), // recipient
            uint8(2), // withdrawMode
            uint8(0) // isV1Pool
        );

        // Record balances before swap
        uint256 inBefore = WETH.balanceOf(USER_SENDER);
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            route
        );

        // Verify that WETH was spent and some USDC_C was received
        uint256 inAfter = WETH.balanceOf(USER_SENDER);
        uint256 outAfter = USDC.balanceOf(USER_SENDER);

        assertEq(inBefore - inAfter, amountIn, "WETH spent mismatch");
        assertGt(outAfter - outBefore, 0, "Should receive USDC");

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Fund the aggregator with 1 000 WETH
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20), // aggregator's funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V1, // pool address
            address(USER_SENDER), // recipient
            uint8(2), // withdrawMode
            uint8(1), // isV1Pool
            address(SYNC_SWAP_VAULT) // vault
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        liFiDEXAggregator.processRoute(
            address(WETH),
            swapAmount,
            address(USDC),
            0,
            USER_SENDER,
            route
        );

        // Verify that some USDC was received
        uint256 outAfter = USDC.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive USDC");

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator_PoolV2() public {
        // Fund the aggregator with 1 000 WETH
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), address(liFiDEXAggregator), amountIn);

        vm.startPrank(USER_SENDER);
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20), // aggregator's funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V2, // pool address
            address(USER_SENDER), // recipient
            uint8(2) // withdrawMode
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        liFiDEXAggregator.processRoute(
            address(WETH),
            swapAmount,
            address(USDC),
            0,
            USER_SENDER,
            route
        );

        // Verify that some USDC was received
        uint256 outAfter = USDC.balanceOf(USER_SENDER);
        assertGt(outAfter - outBefore, 0, "Should receive USDC");

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        uint256 amountIn = 1_000e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(liFiDEXAggregator), amountIn);

        uint256 initialBalanceIn = WETH.balanceOf(USER_SENDER);
        uint256 initialBalanceOut = USDT.balanceOf(USER_SENDER);

        //
        // 1) PROCESS_USER_ERC20:  WETH → USDC   (SyncSwap V1 → withdrawMode=2 → vault that still holds USDC)
        //
        bytes memory hop1 = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(WETH),
            uint8(1), // one pool
            FULL_SHARE, // 100% of the WETH
            uint8(PoolType.SyncSwapV2),
            USDC_WETH_POOL_V1, // the V1 pool
            SYNC_SWAP_VAULT, // “to” = the vault address
            uint8(2), // withdrawMode = 2
            uint8(1), // isV1Pool = true
            address(SYNC_SWAP_VAULT) // vault
        );

        //
        // 2) PROCESS_ONE_POOL: now swap that USDC → USDT via SyncSwap pool V1
        //
        bytes memory hop2 = abi.encodePacked(
            uint8(CommandType.ProcessOnePool),
            address(USDC),
            uint8(PoolType.SyncSwapV2),
            USDC_USDT_POOL_V1, // V1 USDC⟶USDT pool
            address(USER_SENDER), // send the USDT home
            uint8(2), // withdrawMode = 2
            uint8(1), // isV1Pool = true
            SYNC_SWAP_VAULT // vault
        );

        bytes memory route = bytes.concat(hop1, hop2);

        uint256 amountOut = liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDT),
            0,
            USER_SENDER,
            route
        );

        uint256 afterBalanceIn = WETH.balanceOf(USER_SENDER);
        uint256 afterBalanceOut = USDT.balanceOf(USER_SENDER);

        assertEq(
            initialBalanceIn - afterBalanceIn,
            amountIn,
            "WETH spent mismatch"
        );
        assertEq(
            amountOut,
            afterBalanceOut - initialBalanceOut,
            "USDT amountOut mismatch"
        );
        vm.stopPrank();
    }

    function testRevert_V1PoolMissingVaultAddress() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(liFiDEXAggregator), amountIn);

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V1, // pool address
            address(USER_SENDER), // recipient
            uint8(2), // withdrawMode
            uint8(1), // isV1Pool
            address(0) // vault (invalid address)
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            route
        );

        vm.stopPrank();
    }

    function testRevert_InvalidPoolOrRecipient() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(liFiDEXAggregator), amountIn);

        bytes memory routeWithInvalidPool = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            address(0), // pool address (invalid address)
            address(USER_SENDER), // recipient
            uint8(2), // withdrawMode
            uint8(1), // isV1Pool
            address(SYNC_SWAP_VAULT) // vault
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            routeWithInvalidPool
        );

        bytes memory routeWithInvalidRecipient = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20), // user funds
            address(WETH), // tokenIn
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint8(PoolType.SyncSwapV2), // SyncSwapV2
            USDC_WETH_POOL_V1, // pool address
            address(0), // recipient (invalid address)
            uint8(2), // withdrawMode
            uint8(1), // isV1Pool
            address(SYNC_SWAP_VAULT) // vault
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        liFiDEXAggregator.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            routeWithInvalidRecipient
        );

        vm.stopPrank();
    }
}
