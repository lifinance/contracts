// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseDexFacetTest } from "../BaseDexFacet.t.sol";
import { IzumiV3Facet } from "lifi/Periphery/Lda/Facets/IzumiV3Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";

contract IzumiV3FacetTest is BaseDexFacetTest {
    IzumiV3Facet internal izumiV3Facet;

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

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_BASE",
            blockNumber: 29831758
        });
    }

    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        izumiV3Facet = new IzumiV3Facet();
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = izumiV3Facet.swapIzumiV3.selector;
        functionSelectors[1] = izumiV3Facet.swapX2YCallback.selector;
        functionSelectors[2] = izumiV3Facet.swapY2XCallback.selector;
        return (address(izumiV3Facet), functionSelectors);
    }

    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        izumiV3Facet = IzumiV3Facet(facetAddress);
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
        // Fund the sender with tokens
        uint256 amountIn = AMOUNT_USDC;
        deal(USDC, USER_SENDER, amountIn);

        // Capture initial token balances
        uint256 initialBalanceIn = IERC20(USDC).balanceOf(USER_SENDER);
        uint256 initialBalanceOut = IERC20(USDB_C).balanceOf(USER_SENDER);

        // Build first swap data: USDC -> WETH
        bytes memory firstSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: IZUMI_WETH_USDC_POOL,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(coreRouteFacet)
            })
        );

        // Build second swap data: WETH -> USDB_C
        bytes memory secondSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: IZUMI_WETH_USDB_C_POOL,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        // Prepare params for both hops
        SwapTestParams[] memory params = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        // First hop: USDC -> WETH
        params[0] = SwapTestParams({
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            sender: USER_SENDER,
            recipient: address(coreRouteFacet),
            isAggregatorFunds: false // ProcessUserERC20
        });
        swapData[0] = firstSwapData;

        // Second hop: WETH -> USDB_C
        params[1] = SwapTestParams({
            tokenIn: WETH,
            tokenOut: USDB_C,
            amountIn: 0, // Will be determined by first swap
            sender: USER_SENDER,
            recipient: USER_SENDER,
            isAggregatorFunds: true // ProcessMyERC20
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        // Approve tokens
        vm.startPrank(USER_SENDER);
        IERC20(USDC).approve(address(ldaDiamond), amountIn);

        // Execute the swap
        uint256 amountOut = coreRouteFacet.processRoute(
            USDC,
            amountIn,
            USDB_C,
            0, // No minimum amount for testing
            USER_SENDER,
            route
        );
        vm.stopPrank();

        // Verify balances
        uint256 finalBalanceIn = IERC20(USDC).balanceOf(USER_SENDER);
        uint256 finalBalanceOut = IERC20(USDB_C).balanceOf(USER_SENDER);

        assertEq(
            initialBalanceIn - finalBalanceIn,
            amountIn,
            "TokenIn amount mismatch"
        );
        assertGt(finalBalanceOut, initialBalanceOut, "TokenOut not received");
        assertEq(
            amountOut,
            finalBalanceOut - initialBalanceOut,
            "AmountOut mismatch"
        );
    }

    function test_CanSwap() public override {
        deal(address(USDC), USER_SENDER, AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        IERC20(USDC).approve(address(ldaDiamond), AMOUNT_USDC);

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

        IERC20(USDC).approve(address(ldaDiamond), AMOUNT_USDC);

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
        IERC20(WETH).approve(address(ldaDiamond), type(uint256).max);

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
                address(ldaDiamond),
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
        IERC20(params.tokenIn).approve(address(ldaDiamond), params.amountIn);

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
