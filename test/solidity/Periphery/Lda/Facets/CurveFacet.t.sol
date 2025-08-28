// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseDEXFacetTest } from "../BaseDEXFacet.t.sol";
import { CurveFacet } from "lifi/Periphery/Lda/Facets/CurveFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title CurveFacetTest
/// @notice Linea Curve tests via LDA route.
/// @dev Verifies single-hop, aggregator flow, and revert paths.
contract CurveFacetTest is BaseDEXFacetTest {
    /// @notice Facet proxy for swaps bound to the diamond after setup.
    CurveFacet internal curveFacet;

    /// @notice Additional legacy curve pool for stETH/ETH
    address internal poolStETHETH;
    /// @notice stETH token for stETH/ETH pool
    IERC20 internal stETH;

    /// @notice Selects Linea fork and block height used by tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "mainnet",
            blockNumber: 23224347
        });
    }

    /// @notice Deploys CurveFacet and returns its swap selector for diamond cut.
    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        curveFacet = new CurveFacet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = curveFacet.swapCurve.selector;
        return (address(curveFacet), functionSelectors);
    }

    /// @notice Sets the facet instance to the diamond proxy after facet cut.
    function _setFacetInstance(address payable ldaDiamond) internal override {
        curveFacet = CurveFacet(ldaDiamond);
    }

    /// @notice Defines tokens and pools used by tests (WETH/USDC/USDT).
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E); // crvUSD
        tokenMid = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48); // USDC
        tokenOut = IERC20(0xdAC17F958D2ee523a2206206994597C13D831ec7); // USDT
        poolInMid = 0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E; // crvUSD-USDC
        poolMidOut = 0x4f493B7dE8aAC7d55F71853688b1F7C8F0243C85; // USDC-USDT

        // additional tokens for legacy curve pools
        poolStETHETH = 0xDC24316b9AE028F1497c275EB9192a3Ea0f67022; // stETH/ETH pool
        stETH = IERC20(0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84); // stETH
    }

    /// @notice Single‐pool swap: USER sends crvUSD → receives USDC.
    function test_CanSwap() public override {
        // Transfer 1 000 crvUSD from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolInMid,
                isV2: true, // This is a V2 pool
                fromIndex: 1, // Changed: crvUSD is at index 1
                toIndex: 0, // Changed: USDC is at index 0
                destinationAddress: address(USER_SENDER),
                tokenOut: address(tokenMid)
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
            swapData
        );

        vm.stopPrank();
    }

    function test_CanSwap_FromDexAggregator() public override {
        // Fund the aggregator with 1 000 crvUSD
        deal(
            address(tokenIn),
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolInMid,
                isV2: true, // This is a V2 pool
                fromIndex: 1, // Changed: crvUSD is at index 1
                toIndex: 0, // Changed: USDC is at index 0
                destinationAddress: address(USER_SENDER),
                tokenOut: address(tokenMid)
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn() - 1, // Account for slot-undrain
                minOut: 0,
                sender: address(ldaDiamond),
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeSelfERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    function test_CanSwap_MultiHop() public override {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), _getDefaultAmountForTokenIn());

        // Build swap data for both hops
        bytes memory firstSwapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolInMid,
                isV2: true, // This is a V2 pool
                fromIndex: 1, // Changed: crvUSD is at index 1
                toIndex: 0, // Changed: USDC is at index 0
                destinationAddress: poolMidOut,
                tokenOut: address(tokenMid)
            })
        );

        bytes memory secondSwapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolMidOut,
                isV2: true, // was false; NG pool uses 5-arg + exchange_received
                fromIndex: 0,
                toIndex: 1,
                destinationAddress: address(USER_SENDER),
                tokenOut: address(tokenOut)
            })
        );

        SwapTestParams[] memory params = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        params[0] = SwapTestParams({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenMid),
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: poolMidOut,
            commandType: CommandType.DistributeUserERC20
        });
        swapData[0] = firstSwapData;

        params[1] = SwapTestParams({
            tokenIn: address(tokenMid),
            tokenOut: address(tokenOut),
            amountIn: 0,
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DispatchSinglePoolSwap
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route
        );

        vm.stopPrank();
    }

    /// @notice Empty test as Curve does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_CallbackFromUnexpectedSender() public override {
        // Curve does not use callbacks - test intentionally empty
    }

    /// @notice Empty test as Curve does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_SwapWithoutCallback() public override {
        // Curve does not use callbacks - test intentionally empty
    }

    /// @notice Legacy 3pool swap: USER sends USDC → receives USDT via 4-arg exchange (isV2=false).
    function test_CanSwap_Legacy3Pool_USDC_to_USDT() public {
        // 3pool (DAI,USDC,USDT) mainnet
        address poolLegacy = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
        uint256 amountIn = 1_000 * 1e6; // 1,000 USDC (6 decimals)

        // Fund user with USDC
        deal(address(tokenMid), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // Build legacy swap data (isV2=false → 4-arg exchange)
        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolLegacy,
                isV2: false, // legacy/main path
                fromIndex: 1, // USDC index in 3pool
                toIndex: 2, // USDT index in 3pool
                destinationAddress: USER_SENDER,
                tokenOut: address(tokenOut) // USDT
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenMid), // USDC
                tokenOut: address(tokenOut), // USDT
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Legacy 3pool swap funded by aggregator: USDC → USDT via 4-arg exchange (isV2=false).
    function test_CanSwap_FromDexAggregator_Legacy3Pool_USDC_to_USDT() public {
        address poolLegacy = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
        uint256 amountIn = 1_000 * 1e6;

        // Fund aggregator with USDC
        deal(address(tokenMid), address(ldaDiamond), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolLegacy,
                isV2: false, // legacy/main path
                fromIndex: 1, // USDC
                toIndex: 2, // USDT
                destinationAddress: USER_SENDER,
                tokenOut: address(tokenOut)
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenMid), // USDC
                tokenOut: address(tokenOut), // USDT
                amountIn: amountIn - 1, // follow undrain convention
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeSelfERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Tests that the facet reverts on zero pool or destination addresses.
    /// @dev Verifies the InvalidCallData revert condition in swapCurve.
    function testRevert_InvalidPoolOrDestinationAddress() public {
        // Fund user with tokens to avoid underflow in approval
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        // --- Test case 1: Zero pool address ---
        bytes memory swapDataZeroPool = _buildCurveSwapData(
            CurveSwapParams({
                pool: address(0), // Invalid pool
                isV2: true,
                fromIndex: 1,
                toIndex: 0,
                destinationAddress: USER_SENDER,
                tokenOut: address(tokenMid)
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn(), // Use actual amount since we need valid approvals
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataZeroPool,
            InvalidCallData.selector
        );

        // --- Test case 2: Zero destination address ---
        bytes memory swapDataZeroDestination = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolInMid,
                isV2: true,
                fromIndex: 1,
                toIndex: 0,
                destinationAddress: address(0), // Invalid destination
                tokenOut: address(tokenMid)
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn(), // Use actual amount since we need valid approvals
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataZeroDestination,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Legacy stETH pool swap: USER sends native ETH → receives stETH via 4-arg exchange.
    function test_CanSwap_LegacyEthPool_ETH_to_stETH() public {
        // stETH/ETH pool on mainnet
        uint256 amountIn = 1 ether; // 1 native ETH

        // Fund user with ETH
        vm.deal(USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // Build legacy swap data for ETH -> stETH
        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolStETHETH,
                isV2: false, // legacy path
                fromIndex: 0, // ETH index in stETH pool
                toIndex: 1, // stETH index in stETH pool
                destinationAddress: USER_SENDER,
                tokenOut: address(stETH)
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(0), // Native ETH
                tokenOut: address(stETH),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeNative // Use native ETH distribution
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Legacy stETH pool swap: USER sends stETH → receives native ETH via 4-arg exchange.
    function test_CanSwap_LegacyEthPool_stETH_to_ETH() public {
        // stETH/ETH pool on mainnet
        uint256 amountIn = 1 ether; // 1 stETH

        address stETHWhaleAddress = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

        // Fund user with stETH
        vm.prank(stETHWhaleAddress);
        stETH.transfer(USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // Build legacy swap data for stETH -> ETH
        bytes memory swapData = _buildCurveSwapData(
            CurveSwapParams({
                pool: poolStETHETH,
                isV2: false, // legacy path
                fromIndex: 1, // stETH index
                toIndex: 0, // ETH index
                destinationAddress: USER_SENDER,
                tokenOut: address(0) // Native ETH
            })
        );

        // Use the standard helper with isFeeOnTransferToken=true to handle stETH balance differences
        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(stETH),
                tokenOut: address(0), // Native ETH
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            new ExpectedEvent[](0),
            true // Allow for small balance differences due to stETH rebasing
        );

        vm.stopPrank();
    }

    /// @notice Curve swap parameter shape used for `swapCurve`.
    struct CurveSwapParams {
        address pool;
        bool isV2;
        int8 fromIndex;
        int8 toIndex;
        address destinationAddress;
        address tokenOut;
    }

    /// @notice Builds Curve swap payload for route steps.
    /// @param params pool/to/withdrawMode/isV1Pool/vault tuple.
    function _buildCurveSwapData(
        CurveSwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                curveFacet.swapCurve.selector,
                params.pool,
                params.isV2 ? 1 : 0,
                params.fromIndex,
                params.toIndex,
                params.destinationAddress,
                params.tokenOut
            );
    }
}
