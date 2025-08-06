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
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";

import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { VelodromeV2Facet } from "lifi/Periphery/Lda/Facets/VelodromeV2Facet.sol";
import { AlgebraFacet } from "lifi/Periphery/Lda/Facets/AlgebraFacet.sol";
import { IzumiV3Facet } from "lifi/Periphery/Lda/Facets/IzumiV3Facet.sol";

import { TestToken as ERC20 } from "../../utils/TestToken.sol";
import { MockFeeOnTransferToken } from "../../utils/MockTokenFeeOnTransfer.sol";
import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";

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
 * @title LiFiDexAggregatorUpgradeTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract LiFiDexAggregatorUpgradeTest is LdaDiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    CoreRouteFacet internal coreRouteFacet;

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

    function _addDexFacet() internal virtual;

    // Setup function for Apechain tests
    function setupApechain() internal {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 12912470;
    }

    function setupHyperEVM() internal {
        customRpcUrlForForking = "ETH_NODE_URI_HYPEREVM";
        customBlockNumberForForking = 4433562;
    }

    function setUp() public virtual override {
        fork();
        LdaDiamondTest.setUp();
        _addCoreRouteFacet();
        _addDexFacet();
    }

    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(
            address(ldaDiamond),
            address(coreRouteFacet),
            functionSelectors
        );

        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));
    }

    // function test_ContractIsSetUpCorrectly() public {
    //     assertEq(address(liFiDEXAggregator.BENTO_BOX()), address(0xCAFE));
    //     assertEq(
    //         liFiDEXAggregator.priviledgedUsers(address(USER_DIAMOND_OWNER)),
    //         true
    //     );
    //     assertEq(liFiDEXAggregator.owner(), USER_DIAMOND_OWNER);
    // }

    // function testRevert_FailsIfOwnerIsZeroAddress() public {
    //     vm.expectRevert(InvalidConfig.selector);

    //     liFiDEXAggregator = new LiFiDEXAggregator(
    //         address(0xCAFE),
    //         privileged,
    //         address(0)
    //     );
    // }

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
 * @notice Tests specific to Velodrome V2
 */
contract LiFiDexAggregatorVelodromeV2UpgradeTest is
    LiFiDexAggregatorUpgradeTest
{
    VelodromeV2Facet internal velodromeV2Facet;

    // ==================== Velodrome V2 specific variables ====================
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
    }

    function setUp() public override {
        setupOptimism();
        super.setUp();

        deal(address(USDC_TOKEN), address(USER_SENDER), 1_000 * 1e6);
    }

    function _addDexFacet() internal override {
        velodromeV2Facet = new VelodromeV2Facet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = velodromeV2Facet.swapVelodromeV2.selector;
        addFacet(
            address(ldaDiamond),
            address(velodromeV2Facet),
            functionSelectors
        );

        velodromeV2Facet = VelodromeV2Facet(payable(address(ldaDiamond)));
    }

    // ============================ Velodrome V2 Tests ============================

    // no stable swap
    function test_CanSwap() public override {
        vm.startPrank(USER_SENDER);

        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(USER_SENDER),
                to: address(USER_SENDER),
                tokenIn: address(USDC_TOKEN),
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
                tokenOut: address(USDC_TOKEN),
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
                tokenIn: address(USDC_TOKEN),
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
                tokenOut: address(USDC_TOKEN),
                stable: false,
                direction: SwapDirection.Token1ToToken0,
                callback: false
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // fund dex aggregator contract so that the contract holds USDC
        deal(address(USDC_TOKEN), address(ldaDiamond), 100_000 * 1e6);

        vm.startPrank(USER_SENDER);
        _testSwap(
            VelodromeV2SwapTestParams({
                from: address(ldaDiamond),
                to: address(USER_SENDER),
                tokenIn: address(USDC_TOKEN),
                amountIn: IERC20(address(USDC_TOKEN)).balanceOf(
                    address(ldaDiamond)
                ) - 1, // adjust for slot undrain protection: subtract 1 token so that the
                // aggregator's balance isn't completely drained, matching the contract's safeguard
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
                tokenIn: address(USDC_TOKEN),
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
            address(USDC_TOKEN),
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
        IERC20(params.tokenIn).approve(address(ldaDiamond), 1000 * 1e6);

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

        coreRouteFacet.processRoute(
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
            address(USDC_TOKEN),
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

        coreRouteFacet.processRoute(
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
            address(USDC_TOKEN),
            address(STG_TOKEN),
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
            address(USDC_TOKEN),
            uint8(1),
            FULL_SHARE,
            uint16(swapDataZeroPool.length), // Length prefix
            swapDataZeroPool
        );

        IERC20(address(USDC_TOKEN)).approve(address(ldaDiamond), 1000 * 1e6);

        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(USDC_TOKEN),
            1000 * 1e6,
            address(STG_TOKEN),
            0,
            USER_SENDER,
            routeWithZeroPool
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
            address(USDC_TOKEN),
            uint8(1),
            FULL_SHARE,
            uint16(swapDataZeroRecipient.length), // Length prefix
            swapDataZeroRecipient
        );

        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(USDC_TOKEN),
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
            address(USDC_TOKEN),
            address(STG_TOKEN),
            address(USDC_E_TOKEN),
            false,
            false
        );

        // Build multi-hop route
        bytes memory route = _buildMultiHopRoute(params, USER_SENDER, 1, 0);

        deal(address(USDC_TOKEN), USER_SENDER, 1000 * 1e6);

        IERC20(address(USDC_TOKEN)).approve(address(ldaDiamond), 1000 * 1e6);

        // Mock getReserves for the second pool (which uses processOnePool) to return zero reserves
        vm.mockCall(
            params.pool2,
            abi.encodeWithSelector(IVelodromeV2Pool.getReserves.selector),
            abi.encode(0, 0, block.timestamp)
        );

        vm.expectRevert(WrongPoolReserves.selector);

        coreRouteFacet.processRoute(
            address(USDC_TOKEN),
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
        CommandType commandCode = params.from == address(ldaDiamond)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;

        // 1. Pack the data for the specific swap FIRST
        bytes memory swapData = abi.encodePacked(
            VelodromeV2Facet.swapVelodromeV2.selector,
            pool,
            params.direction,
            params.to,
            params.callback
                ? uint8(CallbackStatus.Enabled)
                : uint8(CallbackStatus.Disabled)
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
        uint256 initialTokenOut = IERC20(params.tokenOut).balanceOf(params.to);
        emit log_named_uint("Initial tokenIn balance", initialTokenIn);

        address from = params.from == address(ldaDiamond)
            ? USER_SENDER
            : params.from;
        if (params.callback == true) {
            vm.expectEmit(true, false, false, false);
            emit HookCalled(
                address(ldaDiamond),
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
        coreRouteFacet.processRoute(
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
        address pool1,
        address pool2, // The recipient of the first hop is the next pool
        uint8 direction
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                VelodromeV2Facet.swapVelodromeV2.selector,
                pool1,
                direction,
                pool2, // Send intermediate tokens to the next pool for the second hop
                uint8(CallbackStatus.Disabled)
            );
    }

    // function to build second hop of the route
    function _buildSecondHop(
        address pool2,
        address recipient,
        uint8 direction
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                VelodromeV2Facet.swapVelodromeV2.selector,
                pool2,
                direction,
                recipient, // Final recipient
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
        // 1. Get the specific data for each hop
        bytes memory firstHopData = _buildFirstHop(
            params.pool1,
            params.pool2,
            firstHopDirection
        );

        bytes memory secondHopData = _buildSecondHop(
            params.pool2,
            recipient,
            secondHopDirection
        );

        // 2. Assemble the first command
        bytes memory firstCommand = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            params.tokenIn,
            uint8(1), // num splits
            FULL_SHARE,
            uint16(firstHopData.length), // <--- Add length prefix
            firstHopData
        );

        // 3. Assemble the second command
        // The second hop takes tokens already held by the diamond, so we use ProcessOnePool
        bytes memory secondCommand = abi.encodePacked(
            uint8(CommandType.ProcessOnePool),
            params.tokenMid,
            uint16(secondHopData.length), // <--- Add length prefix
            secondHopData
        );

        // 4. Concatenate the commands to create the final route
        return bytes.concat(firstCommand, secondCommand);
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
 * @notice Tests specific to Algebra
 */
contract LiFiDexAggregatorAlgebraUpgradeTest is LiFiDexAggregatorUpgradeTest {
    AlgebraFacet private algebraFacet;

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
        super.setUp();
    }

    function _addDexFacet() internal override {
        algebraFacet = new AlgebraFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = algebraFacet.swapAlgebra.selector;
        functionSelectors[1] = algebraFacet.algebraSwapCallback.selector;
        addFacet(
            address(ldaDiamond),
            address(algebraFacet),
            functionSelectors
        );

        algebraFacet = AlgebraFacet(payable(address(ldaDiamond)));
    }

    // Override the abstract test with Algebra implementation
    function test_CanSwap_FromDexAggregator() public override {
        // Fund LDA from whale address
        vm.prank(APE_ETH_HOLDER_APECHAIN);
        IERC20(APE_ETH_TOKEN).transfer(address(coreRouteFacet), 1 * 1e18);

        vm.startPrank(USER_SENDER);

        _testAlgebraSwap(
            AlgebraSwapTestParams({
                from: address(coreRouteFacet),
                to: address(USER_SENDER),
                tokenIn: APE_ETH_TOKEN,
                amountIn: IERC20(APE_ETH_TOKEN).balanceOf(
                    address(coreRouteFacet)
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

        IERC20(APE_ETH_TOKEN).approve(address(coreRouteFacet), amountIn);

        // Build route for algebra swap with command code 2 (user funds)
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: APE_ETH_HOLDER_APECHAIN,
                pool: ALGEBRA_POOL_APECHAIN,
                supportsFeeOnTransfer: true
            })
        );

        // 2. Build the final route with the command and length-prefixed swapData
        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            APE_ETH_TOKEN,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // <--- Add the length prefix
            swapData
        );

        // Track initial balance
        uint256 beforeBalance = IERC20(WETH_TOKEN).balanceOf(
            APE_ETH_HOLDER_APECHAIN
        );

        // Execute the swap
        coreRouteFacet.processRoute(
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
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: USER_SENDER,
                pool: invalidPool,
                supportsFeeOnTransfer: true
            })
        );

        bytes memory invalidRoute = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            APE_ETH_TOKEN,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // <--- Add the length prefix
            swapData
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(coreRouteFacet), 1 * 1e18);

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

        coreRouteFacet.processRoute(
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
            address(coreRouteFacet),
            state.amountIn
        );

        // Build route
        bytes memory route = _buildMultiHopRouteForTest(state);

        // Execute swap
        coreRouteFacet.processRoute(
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
        // 1. Get the specific data payload for each hop
        bytes memory firstHopData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: address(state.tokenA),
                recipient: address(ldaDiamond), // Hop 1 sends to the contract itself
                pool: state.pool1,
                supportsFeeOnTransfer: false
            })
        );

        bytes memory secondHopData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessMyERC20,
                tokenIn: address(state.tokenB),
                recipient: USER_SENDER, // Hop 2 sends to the final user
                pool: state.pool2,
                supportsFeeOnTransfer: state.isFeeOnTransfer
            })
        );

        // 2. Assemble the first full command with its length prefix
        bytes memory firstCommand = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            state.tokenA,
            uint8(1),
            FULL_SHARE,
            uint16(firstHopData.length),
            firstHopData
        );

        // 3. Assemble the second full command with its length prefix
        bytes memory secondCommand = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            state.tokenB,
            uint8(1), // num splits for the second hop
            FULL_SHARE, // full share for the second hop
            uint16(secondHopData.length),
            secondHopData
        );

        // 4. Concatenate the commands to create the final route
        return bytes.concat(firstCommand, secondCommand);
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
    function _buildAlgebraSwapData(
        AlgebraRouteParams memory params
    ) private view returns (bytes memory) {
        address token0 = IAlgebraPool(params.pool).token0();
        bool zeroForOne = (params.tokenIn == token0);
        SwapDirection direction = zeroForOne
            ? SwapDirection.Token0ToToken1
            : SwapDirection.Token1ToToken0;

        // This data blob is what the AlgebraFacet will receive and parse
        return
            abi.encodePacked(
                AlgebraFacet.swapAlgebra.selector,
                params.pool,
                uint8(direction),
                params.recipient,
                params.supportsFeeOnTransfer ? uint8(1) : uint8(0)
            );
    }

    // Helper function to test an Algebra swap
    function _testAlgebraSwap(AlgebraSwapTestParams memory params) internal {
        // Find or create a pool
        address pool = _getPool(params.tokenIn, params.tokenOut);
        vm.label(pool, "AlgebraPool");

        // Get token0 from pool for labeling
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
        uint256 expectedOutput = _getQuoteExactInput(
            params.tokenIn,
            params.tokenOut,
            params.amountIn
        );

        // 1. Pack the specific data for this swap
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20, // Placeholder, not used in this helper
                tokenIn: params.tokenIn,
                recipient: params.to,
                pool: pool,
                supportsFeeOnTransfer: params.supportsFeeOnTransfer
            })
        );

        // 2. Approve tokens
        IERC20(params.tokenIn).approve(
            address(coreRouteFacet),
            params.amountIn
        );

        // 3. Set up event expectations
        address fromAddress = params.from == address(coreRouteFacet)
            ? USER_SENDER
            : params.from;

        vm.expectEmit(true, true, true, false);
        emit Route(
            fromAddress,
            params.to,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            expectedOutput,
            expectedOutput
        );

        // 4. Build the route inline and execute the swap to save stack space
        coreRouteFacet.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            (expectedOutput * 995) / 1000, // minOut calculated inline
            params.to,
            abi.encodePacked(
                uint8(
                    params.from == address(coreRouteFacet)
                        ? CommandType.ProcessMyERC20
                        : CommandType.ProcessUserERC20
                ),
                params.tokenIn,
                uint8(1),
                FULL_SHARE,
                uint16(swapData.length),
                swapData
            )
        );

        // 5. Verify final balances
        uint256 finalTokenIn = IERC20(params.tokenIn).balanceOf(params.from);
        uint256 finalTokenOut = IERC20(params.tokenOut).balanceOf(params.to);

        assertApproxEqAbs(
            initialTokenIn - finalTokenIn,
            params.amountIn,
            1,
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
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: USER_SENDER,
                pool: address(0), // Zero address pool
                supportsFeeOnTransfer: true
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            APE_ETH_TOKEN,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // <--- Add the length prefix
            swapData
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(coreRouteFacet), 1 * 1e18);

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);

        coreRouteFacet.processRoute(
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

    // function testRevert_AlgebraSwap_ImpossiblePoolAddress() public {
    //     // Transfer tokens from whale to user
    //     vm.prank(APE_ETH_HOLDER_APECHAIN);
    //     IERC20(APE_ETH_TOKEN).transfer(USER_SENDER, 1 * 1e18);

    //     vm.startPrank(USER_SENDER);

    //     // Mock token0() call on IMPOSSIBLE_POOL_ADDRESS
    //     vm.mockCall(
    //         IMPOSSIBLE_POOL_ADDRESS,
    //         abi.encodeWithSelector(IAlgebraPool.token0.selector),
    //         abi.encode(APE_ETH_TOKEN)
    //     );

    //     // Build route with IMPOSSIBLE_POOL_ADDRESS as pool
    //     bytes memory swapData = _buildAlgebraSwapData(
    //         AlgebraRouteParams({
    //             commandCode: CommandType.ProcessUserERC20,
    //             tokenIn: APE_ETH_TOKEN,
    //             recipient: USER_SENDER,
    //             pool: IMPOSSIBLE_POOL_ADDRESS, // Impossible pool address
    //             supportsFeeOnTransfer: true
    //         })
    //     );

    //     bytes memory route = abi.encodePacked(
    //         uint8(CommandType.ProcessUserERC20),
    //         APE_ETH_TOKEN,
    //         uint8(1), // number of pools/splits
    //         FULL_SHARE, // 100% share
    //         uint16(swapData.length), // <--- Add the length prefix
    //         swapData
    //     );

    //     // Approve tokens
    //     IERC20(APE_ETH_TOKEN).approve(address(coreRouteFacet), 1 * 1e18);

    //     // Expect revert with InvalidCallData
    //     vm.expectRevert(InvalidCallData.selector);

    //     coreRouteFacet.processRoute(
    //         APE_ETH_TOKEN,
    //         1 * 1e18,
    //         address(WETH_TOKEN),
    //         0,
    //         USER_SENDER,
    //         route
    //     );

    //     vm.stopPrank();
    //     vm.clearMockedCalls();
    // }

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
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.ProcessUserERC20,
                tokenIn: APE_ETH_TOKEN,
                recipient: address(0), // Zero address recipient
                pool: ALGEBRA_POOL_APECHAIN,
                supportsFeeOnTransfer: true
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            APE_ETH_TOKEN,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // <--- Add the length prefix
            swapData
        );

        // Approve tokens
        IERC20(APE_ETH_TOKEN).approve(address(coreRouteFacet), 1 * 1e18);

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);

        coreRouteFacet.processRoute(
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
 * @title LiFiDexAggregatorIzumiV3UpgradeTest
 * @notice Tests specific to iZiSwap V3 selector
 */
contract LiFiDexAggregatorIzumiV3UpgradeTest is LiFiDexAggregatorUpgradeTest {
    IzumiV3Facet private izumiV3Facet;

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

    // Setup function for Base tests
    function setupBase() internal {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 29831758;
    }

    function setUp() public override {
        setupBase();
        super.setUp();

        deal(address(USDC), address(USER_SENDER), 1_000 * 1e6);
    }

    function _addDexFacet() internal override {
        izumiV3Facet = new IzumiV3Facet();
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = izumiV3Facet.swapIzumiV3.selector;
        functionSelectors[1] = izumiV3Facet.swapX2YCallback.selector;
        functionSelectors[2] = izumiV3Facet.swapY2XCallback.selector;
        addFacet(
            address(ldaDiamond),
            address(izumiV3Facet),
            functionSelectors
        );

        izumiV3Facet = IzumiV3Facet(payable(address(ldaDiamond)));
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Test USDC -> WETH
        deal(USDC, address(coreRouteFacet), AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        _testSwap(
            IzumiV3SwapTestParams({
                from: address(coreRouteFacet),
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
        IERC20(USDC).approve(address(coreRouteFacet), AMOUNT_USDC);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: IZUMI_WETH_USDC_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_RECEIVER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            USDC,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        vm.expectEmit(true, true, true, false);
        emit Route(USER_SENDER, USER_RECEIVER, USDC, WETH, AMOUNT_USDC, 0, 0);

        coreRouteFacet.processRoute(
            USDC,
            AMOUNT_USDC,
            WETH,
            0,
            USER_RECEIVER,
            route
        );

        vm.stopPrank();
    }

    function testRevert_IzumiV3SwapUnexpected() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        vm.startPrank(USER_SENDER);

        // create invalid pool address
        address invalidPool = address(0x999);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: invalidPool,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        // create a route with an invalid pool
        bytes memory invalidRoute = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            USDC,
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        IERC20(USDC).approve(address(coreRouteFacet), AMOUNT_USDC);

        // mock the iZiSwap pool to return without updating lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSignature("swapY2X(address,uint128,int24,bytes)"),
            abi.encode(0, 0) // return amountX and amountY without triggering callback or updating lastCalledPool
        );

        vm.expectRevert(IzumiV3SwapUnexpected.selector);

        coreRouteFacet.processRoute(
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

    function testRevert_UnexpectedCallbackSender() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        // Set up the expected callback sender through the diamond
        vm.store(
            address(ldaDiamond),
            keccak256("com.lifi.lda.callbackmanager"),
            bytes32(uint256(uint160(IZUMI_WETH_USDC_POOL)))
        );

        // Try to call callback from a different address than expected
        address unexpectedCaller = address(0xdead);
        vm.prank(unexpectedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibCallbackManager.UnexpectedCallbackSender.selector,
                unexpectedCaller,
                IZUMI_WETH_USDC_POOL
            )
        );
        izumiV3Facet.swapY2XCallback(1, 1, abi.encode(USDC));
    }

    function testRevert_IzumiV3SwapCallbackNotPositiveAmount() public {
        deal(USDC, USER_SENDER, AMOUNT_USDC);

        // Set the expected callback sender through the diamond storage
        vm.store(
            address(ldaDiamond),
            keccak256("com.lifi.lda.callbackmanager"),
            bytes32(uint256(uint160(IZUMI_WETH_USDC_POOL)))
        );

        // try to call the callback with zero amount
        vm.prank(IZUMI_WETH_USDC_POOL);
        vm.expectRevert(IzumiV3SwapCallbackNotPositiveAmount.selector);
        izumiV3Facet.swapY2XCallback(
            0,
            0, // zero amount should trigger the error
            abi.encode(USDC)
        );
    }

    function testRevert_FailsIfAmountInIsTooLarge() public {
        deal(address(WETH), USER_SENDER, type(uint256).max);

        vm.startPrank(USER_SENDER);
        IERC20(WETH).approve(address(coreRouteFacet), type(uint256).max);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: IZUMI_WETH_USDC_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_RECEIVER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            WETH,
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            WETH,
            type(uint216).max,
            USDC,
            0,
            USER_RECEIVER,
            route
        );

        vm.stopPrank();
    }

    function _testSwap(IzumiV3SwapTestParams memory params) internal {
        // Fund the sender with tokens if not the contract itself
        if (params.from != address(coreRouteFacet)) {
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
        CommandType commandCode = params.from == address(coreRouteFacet)
            ? CommandType.ProcessMyERC20
            : CommandType.ProcessUserERC20;

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: IZUMI_WETH_USDC_POOL,
                direction: params.direction == SwapDirection.Token0ToToken1
                    ? SwapDirection.Token0ToToken1
                    : SwapDirection.Token1ToToken0,
                recipient: params.to
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(commandCode),
            params.tokenIn,
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        // Approve tokens if necessary
        if (params.from == USER_SENDER) {
            vm.startPrank(USER_SENDER);
            IERC20(params.tokenIn).approve(
                address(coreRouteFacet),
                params.amountIn
            );
        }

        // Expect the Route event emission
        address from = params.from == address(coreRouteFacet)
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
        uint256 amountOut = coreRouteFacet.processRoute(
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
        uint256 initialBalanceIn = IERC20(params.tokenIn).balanceOf(
            USER_SENDER
        );
        uint256 initialBalanceOut = IERC20(params.tokenOut).balanceOf(
            USER_SENDER
        );

        // Build first swap data
        bytes memory firstSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: params.pool1,
                direction: params.direction1,
                recipient: address(coreRouteFacet)
            })
        );

        bytes memory firstHop = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            params.tokenIn,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(firstSwapData.length), // length prefix
            firstSwapData
        );

        // Build second swap data
        bytes memory secondSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: params.pool2,
                direction: params.direction2,
                recipient: USER_SENDER
            })
        );

        bytes memory secondHop = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            params.tokenMid,
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(secondSwapData.length), // length prefix
            secondSwapData
        );

        // Combine into route
        bytes memory route = bytes.concat(firstHop, secondHop);

        // Approve tokens
        vm.startPrank(USER_SENDER);
        IERC20(params.tokenIn).approve(
            address(coreRouteFacet),
            params.amountIn
        );

        // Execute the swap
        uint256 amountOut = coreRouteFacet.processRoute(
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
                IzumiV3Facet.swapIzumiV3.selector,
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
            address(coreRouteFacet)
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

    struct IzumiV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    function _buildIzumiV3SwapData(
        IzumiV3SwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                izumiV3Facet.swapIzumiV3.selector,
                params.pool,
                uint8(params.direction),
                params.recipient
            );
    }
}

// -----------------------------------------------------------------------------
//  HyperswapV3 on HyperEVM
// -----------------------------------------------------------------------------
contract LiFiDexAggregatorHyperswapV3UpgradeTest is
    LiFiDexAggregatorUpgradeTest
{
    using SafeERC20 for IERC20;

    UniV3StyleFacet internal uniV3StyleFacet;

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
        super.setUp();

        deal(address(USDT0), address(USER_SENDER), 1_000 * 1e6);
    }

    function _addDexFacet() internal override {
        uniV3StyleFacet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3StyleFacet.swapUniV3.selector;
        functionSelectors[1] = uniV3StyleFacet
            .hyperswapV3SwapCallback
            .selector;
        addFacet(
            address(ldaDiamond),
            address(uniV3StyleFacet),
            functionSelectors
        );

        uniV3StyleFacet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e6; // 1000 USDT0

        deal(address(USDT0), USER_SENDER, amountIn);

        // user approves
        vm.prank(USER_SENDER);
        USDT0.approve(address(uniV3StyleFacet), amountIn);

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

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: pool,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(USDT0),
            uint8(1), // 1 pool
            FULL_SHARE, // FULL_SHARE
            uint16(swapData.length), // length prefix
            swapData
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
        coreRouteFacet.processRoute(
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
        deal(address(USDT0), address(ldaDiamond), amountIn);

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
        // bytes memory route = _buildHyperswapV3Route(
        //     HyperswapV3Params({
        //         commandCode: CommandType.ProcessMyERC20,
        //         tokenIn: address(USDT0),
        //         recipient: USER_SENDER,
        //         pool: pool,
        //         zeroForOne: true // USDT0 < WHYPE
        //     })
        // );

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: pool,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(USDT0),
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
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
        coreRouteFacet.processRoute(
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

    // function _buildHyperswapV3Route(
    //     HyperswapV3Params memory params
    // ) internal pure returns (bytes memory route) {
    //     route = abi.encodePacked(
    //         uint8(params.commandCode),
    //         params.tokenIn,
    //         uint8(1), // 1 pool
    //         FULL_SHARE, // 65535 - 100% share
    //         uint8(PoolType.UniV3), // POOL_TYPE_UNIV3 = 1
    //         params.pool,
    //         uint8(params.zeroForOne ? 0 : 1), // Convert bool to uint8: 0 for true, 1 for false
    //         params.recipient
    //     );

    //     return route;
    // }

    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    function _buildUniV3SwapData(
        UniV3SwapParams memory params
    ) internal returns (bytes memory) {
        return
            abi.encodePacked(
                uniV3StyleFacet.swapUniV3.selector,
                params.pool,
                uint8(params.direction),
                params.recipient
            );
    }
}

// -----------------------------------------------------------------------------
//  LaminarV3 on HyperEVM
// -----------------------------------------------------------------------------
contract LiFiDexAggregatorLaminarV3UpgradeTest is
    LiFiDexAggregatorUpgradeTest
{
    UniV3StyleFacet internal uniV3StyleFacet;
    using SafeERC20 for IERC20;

    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);
    IERC20 internal constant LHYPE =
        IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562);

    address internal constant WHYPE_LHYPE_POOL =
        0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45;

    function setUp() public override {
        setupHyperEVM();
        super.setUp();
    }

    function _addDexFacet() internal override {
        uniV3StyleFacet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3StyleFacet.swapUniV3.selector;
        functionSelectors[1] = uniV3StyleFacet.laminarV3SwapCallback.selector;
        addFacet(
            address(ldaDiamond),
            address(uniV3StyleFacet),
            functionSelectors
        );

        uniV3StyleFacet = UniV3StyleFacet(payable(address(ldaDiamond)));
    }

    function test_CanSwap() public override {
        uint256 amountIn = 1_000 * 1e18;

        // Fund the user with WHYPE
        deal(address(WHYPE), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WHYPE.approve(address(uniV3StyleFacet), amountIn);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: WHYPE_LHYPE_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(WHYPE),
            uint8(1), // one pool
            FULL_SHARE, // 100%
            uint16(swapData.length), // length prefix
            swapData
        );

        // Record balances
        uint256 inBefore = WHYPE.balanceOf(USER_SENDER);
        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Execute swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
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
        deal(address(WHYPE), address(uniV3StyleFacet), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildUniV3SwapData(
            UniV3SwapParams({
                pool: WHYPE_LHYPE_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessMyERC20),
            address(WHYPE),
            uint8(1),
            FULL_SHARE,
            uint16(swapData.length), // length prefix
            swapData
        );

        uint256 outBefore = LHYPE.balanceOf(USER_SENDER);

        // Withdraw 1 wei to avoid slot-undrain protection
        coreRouteFacet.processRoute(
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

    struct UniV3SwapParams {
        address pool;
        SwapDirection direction;
        address recipient;
    }

    function _buildUniV3SwapData(
        UniV3SwapParams memory params
    ) internal returns (bytes memory) {
        return
            abi.encodePacked(
                uniV3StyleFacet.swapUniV3.selector,
                params.pool,
                uint8(params.direction),
                params.recipient
            );
    }
}
