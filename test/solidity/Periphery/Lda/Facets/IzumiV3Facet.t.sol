// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseDexFacetTest } from "../BaseDexFacet.t.sol";
import { IzumiV3Facet } from "lifi/Periphery/Lda/Facets/IzumiV3Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";

contract IzumiV3FacetTest is BaseDexFacetTest {
    IzumiV3Facet internal izumiV3Facet;

    uint256 internal constant AMOUNT_USDC = 100 * 1e6; // 100 USDC with 6 decimals

    // structs
    struct IzumiV3SwapTestParams {
        address from;
        address to;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        SwapDirection direction;
    }

    error IzumiV3SwapUnexpected();
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

    // NEW
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913); // USDC
        tokenMid = IERC20(0x4200000000000000000000000000000000000006); // WETH
        tokenOut = IERC20(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA); // USDB_C
        poolInMid = 0xb92A9A91a9F7E8e6Bb848508A6DaF08f9D718554; // WETH/USDC
        poolMidOut = 0xdb5D62f06EEcEf0Da7506e0700c2f03c57016De5; // WETH/USDB_C
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Test USDC -> WETH
        deal(address(tokenIn), address(coreRouteFacet), AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        _testSwap(
            IzumiV3SwapTestParams({
                from: address(coreRouteFacet),
                to: USER_SENDER,
                tokenIn: address(tokenIn),
                amountIn: AMOUNT_USDC,
                tokenOut: address(tokenMid),
                direction: SwapDirection.Token1ToToken0
            })
        );
        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        // Fund the sender with tokens
        uint256 amountIn = AMOUNT_USDC;
        deal(address(tokenIn), USER_SENDER, amountIn);

        // Capture initial token balances
        uint256 initialBalanceIn = IERC20(tokenIn).balanceOf(USER_SENDER);
        uint256 initialBalanceOut = IERC20(tokenOut).balanceOf(USER_SENDER);

        // Build first swap data: USDC -> WETH
        bytes memory firstSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token1ToToken0,
                recipient: address(coreRouteFacet)
            })
        );

        // Build second swap data: WETH -> USDB_C
        bytes memory secondSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolMidOut,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_SENDER
            })
        );

        // Prepare params for both hops
        SwapTestParams[] memory params = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        // First hop: USDC -> WETH
        params[0] = SwapTestParams({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenMid),
            amountIn: amountIn,
            sender: USER_SENDER,
            recipient: address(coreRouteFacet),
            commandType: CommandType.ProcessUserERC20
        });
        swapData[0] = firstSwapData;

        // Second hop: WETH -> USDB_C
        params[1] = SwapTestParams({
            tokenIn: address(tokenMid),
            tokenOut: address(tokenOut),
            amountIn: 0, // Will be determined by first swap
            sender: USER_SENDER,
            recipient: USER_SENDER,
            commandType: CommandType.ProcessMyERC20
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        // Approve tokens
        vm.startPrank(USER_SENDER);
        IERC20(tokenIn).approve(address(ldaDiamond), amountIn);

        // Execute the swap
        uint256 amountOut = coreRouteFacet.processRoute(
            address(tokenIn),
            amountIn,
            address(tokenOut),
            0, // No minimum amount for testing
            USER_SENDER,
            route
        );
        vm.stopPrank();

        // Verify balances
        uint256 finalBalanceIn = IERC20(address(tokenIn)).balanceOf(
            USER_SENDER
        );
        uint256 finalBalanceOut = IERC20(address(tokenOut)).balanceOf(
            USER_SENDER
        );

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
        deal(address(tokenIn), USER_SENDER, AMOUNT_USDC);

        vm.startPrank(USER_SENDER);
        IERC20(tokenIn).approve(address(ldaDiamond), AMOUNT_USDC);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token1ToToken0,
                recipient: USER_RECEIVER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(tokenIn),
            uint8(1), // number of pools/splits
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        vm.expectEmit(true, true, true, false);
        emit Route(
            USER_SENDER,
            USER_RECEIVER,
            address(tokenIn),
            address(tokenMid),
            AMOUNT_USDC,
            0,
            0
        );

        coreRouteFacet.processRoute(
            address(tokenIn),
            AMOUNT_USDC,
            address(tokenMid),
            0,
            USER_RECEIVER,
            route
        );

        vm.stopPrank();
    }

    function testRevert_IzumiV3SwapUnexpected() public {
        deal(address(tokenIn), USER_SENDER, AMOUNT_USDC);

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
            address(tokenIn),
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        // mock the iZiSwap pool to return without updating lastCalledPool
        vm.mockCall(
            invalidPool,
            abi.encodeWithSignature("swapY2X(address,uint128,int24,bytes)"),
            abi.encode(0, 0) // return amountX and amountY without triggering callback or updating lastCalledPool
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: AMOUNT_USDC,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            invalidRoute,
            IzumiV3SwapUnexpected.selector
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    function testRevert_UnexpectedCallbackSender() public {
        deal(address(tokenIn), USER_SENDER, AMOUNT_USDC);

        // Set up the expected callback sender through the diamond
        vm.store(
            address(ldaDiamond),
            keccak256("com.lifi.lda.callbackmanager"),
            bytes32(uint256(uint160(poolInMid)))
        );

        // Try to call callback from a different address than expected
        address unexpectedCaller = address(0xdead);
        vm.prank(unexpectedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibCallbackManager.UnexpectedCallbackSender.selector,
                unexpectedCaller,
                poolInMid
            )
        );
        izumiV3Facet.swapY2XCallback(1, 1, abi.encode(tokenIn));
    }

    function testRevert_IzumiV3SwapCallbackNotPositiveAmount() public {
        deal(address(tokenIn), USER_SENDER, AMOUNT_USDC);

        // Set the expected callback sender through the diamond storage
        vm.store(
            address(ldaDiamond),
            keccak256("com.lifi.lda.callbackmanager"),
            bytes32(uint256(uint160(poolInMid)))
        );

        // try to call the callback with zero amount
        vm.prank(poolInMid);
        vm.expectRevert(IzumiV3SwapCallbackNotPositiveAmount.selector);
        izumiV3Facet.swapY2XCallback(
            0,
            0, // zero amount should trigger the error
            abi.encode(tokenIn)
        );
    }

    function testRevert_FailsIfAmountInIsTooLarge() public {
        deal(address(tokenMid), USER_SENDER, type(uint256).max);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token0ToToken1,
                recipient: USER_RECEIVER
            })
        );

        bytes memory route = abi.encodePacked(
            uint8(CommandType.ProcessUserERC20),
            address(tokenMid),
            uint8(1), // number of pools (1)
            FULL_SHARE, // 100% share
            uint16(swapData.length), // length prefix
            swapData
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenMid),
                tokenOut: address(tokenIn),
                amountIn: type(uint216).max,
                sender: USER_SENDER,
                recipient: USER_RECEIVER,
                commandType: CommandType.ProcessUserERC20
            }),
            route,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    function _testSwap(IzumiV3SwapTestParams memory params) internal {
        // Fund the sender with tokens if not the contract itself
        if (params.from != address(coreRouteFacet)) {
            deal(address(params.tokenIn), params.from, params.amountIn);
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
                pool: poolInMid,
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
            IERC20(address(params.tokenIn)).approve(
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
            address(params.tokenIn),
            params.amountIn,
            address(params.tokenOut),
            0, // No minimum amount for testing
            params.to,
            route
        );

        if (params.from == USER_SENDER) {
            vm.stopPrank();
        }

        // Verify balances have changed correctly
        uint256 finalBalanceIn = IERC20(address(params.tokenIn)).balanceOf(
            params.from
        );
        uint256 finalBalanceOut = IERC20(address(params.tokenOut)).balanceOf(
            params.to
        );

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
