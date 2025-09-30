// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IWETH } from "lifi/Interfaces/IWETH.sol";
import { BaseCoreRouteTest } from "../BaseCoreRoute.t.sol";
import { NativeWrapperFacet } from "lifi/Periphery/LDA/Facets/NativeWrapperFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title NativeWrapperFacetTest
/// @notice Tests for NativeWrapperFacet wrapping/unwrapping functionality
/// @dev Verifies unwrapNative (WETH->ETH) and wrapNative (ETH->WETH) operations with various funding sources
contract NativeWrapperFacetTest is BaseCoreRouteTest {
    /// @notice Facet proxy for native wrapping/unwrapping operations
    NativeWrapperFacet internal nativeWrapperFacet;

    /// @notice WETH token instance for testing
    IWETH internal weth;

    // ==== Custom Errors ====

    /// @dev Thrown when native token operations fail
    error NativeTransferFailed();
    /// @dev Thrown when WETH operations fail
    error WETHOperationFailed();

    // ==== Types ====

    /// @notice Parameters for unwrapNative operation
    /// @param destinationAddress Address to receive unwrapped ETH
    struct UnwrapParams {
        address destinationAddress;
    }

    /// @notice Parameters for wrapNative operation
    /// @param wrappedNative WETH contract address
    /// @param destinationAddress Address to receive wrapped tokens
    struct WrapParams {
        address wrappedNative;
        address destinationAddress;
    }

    // ==== Setup Functions ====

    function setUp() public override {
        // Set fork config for mainnet WETH testing
        customBlockNumberForForking = 23228012;
        customRpcUrlForForking = "ETH_NODE_URI_MAINNET";

        fork();
        super.setUp();

        // Deploy and register NativeWrapperFacet
        nativeWrapperFacet = new NativeWrapperFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = nativeWrapperFacet.unwrapNative.selector;
        functionSelectors[1] = nativeWrapperFacet.wrapNative.selector;

        addFacet(
            address(ldaDiamond),
            address(nativeWrapperFacet),
            functionSelectors
        );

        // Set facet instance to diamond proxy
        nativeWrapperFacet = NativeWrapperFacet(address(ldaDiamond));

        // Setup WETH token
        weth = IWETH(ADDRESS_WRAPPED_NATIVE); // Use constant from TestBase
    }

    // ==== Test Cases ====

    /// @notice Tests unwrapping WETH to ETH from user funds
    function test_CanUnwrap() public {
        uint256 amountIn = 1 ether;

        // Fund user with WETH
        deal(address(weth), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // Record initial ETH balance
        uint256 initialETHBalance = USER_RECEIVER.balance;

        bytes memory swapData = _buildUnwrapSwapData(
            UnwrapParams({ destinationAddress: USER_RECEIVER })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(weth),
            tokenOut: address(0), // Native ETH
            amountIn: amountIn,
            minOut: amountIn, // Expect 1:1 unwrapping
            sender: USER_SENDER,
            destinationAddress: USER_RECEIVER,
            commandType: CommandType.DistributeUserERC20
        });

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        // Verify ETH was received
        assertEq(USER_RECEIVER.balance, initialETHBalance + amountIn);

        vm.stopPrank();
    }

    /// @notice Tests unwrapping WETH to ETH from aggregator funds
    function test_CanUnwrap_FromDexAggregator() public {
        uint256 amountIn = 1 ether;

        // Fund aggregator with WETH
        deal(address(weth), address(ldaDiamond), amountIn + 1);

        vm.startPrank(USER_SENDER);

        // Record initial ETH balance
        uint256 initialETHBalance = USER_RECEIVER.balance;

        bytes memory swapData = _buildUnwrapSwapData(
            UnwrapParams({ destinationAddress: USER_RECEIVER })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(weth),
            tokenOut: address(0), // Native ETH
            amountIn: amountIn,
            minOut: amountIn, // Expect 1:1 unwrapping
            sender: address(ldaDiamond),
            destinationAddress: USER_RECEIVER,
            commandType: CommandType.DistributeSelfERC20
        });

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        // Verify ETH was received
        assertEq(USER_RECEIVER.balance, initialETHBalance + amountIn);

        vm.stopPrank();
    }

    /// @notice Tests wrapping ETH to WETH
    function test_CanWrap2() public {
        uint256 amountIn = 1 ether;

        // Fund aggregator with ETH
        vm.deal(USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // // Record initial WETH balance
        uint256 initialWETHBalance = weth.balanceOf(USER_RECEIVER);

        bytes memory swapData = _buildWrapSwapData(
            WrapParams({
                wrappedNative: address(weth),
                destinationAddress: USER_RECEIVER
            })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(0), // Native ETH
            tokenOut: address(weth),
            amountIn: amountIn,
            minOut: amountIn, // Expect 1:1 wrapping
            sender: USER_SENDER,
            destinationAddress: USER_RECEIVER,
            commandType: CommandType.DistributeNative
        });

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        // Verify WETH was received
        assertEq(weth.balanceOf(USER_RECEIVER), initialWETHBalance + amountIn);

        vm.stopPrank();
    }

    /// @notice Tests wrapping ETH to WETH and keeping on aggregator
    function test_CanWrap_ToAggregator() public {
        uint256 amountIn = 1 ether;

        // Fund aggregator with ETH
        vm.deal(USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        // Record initial WETH balance
        uint256 initialWETHBalance = weth.balanceOf(address(ldaDiamond));

        bytes memory swapData = _buildWrapSwapData(
            WrapParams({
                wrappedNative: address(weth),
                destinationAddress: address(ldaDiamond)
            })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(0), // Native ETH
            tokenOut: address(weth),
            amountIn: amountIn,
            minOut: amountIn, // Expect 1:1 wrapping
            sender: USER_SENDER,
            destinationAddress: address(ldaDiamond),
            commandType: CommandType.DistributeNative
        });

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route);

        // Verify WETH was received by aggregator
        assertEq(
            weth.balanceOf(address(ldaDiamond)),
            initialWETHBalance + amountIn
        );

        vm.stopPrank();
    }

    /// @notice Tests that wrapNative reverts with zero wrapped native address
    function testRevert_WrapNative_ZeroWrappedNative() public {
        uint256 amountIn = 1 ether;

        // Fund user with ETH (not aggregator, since this is DistributeNative)
        vm.deal(USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildWrapSwapData(
            WrapParams({
                wrappedNative: address(0), // Invalid wrapped native
                destinationAddress: USER_RECEIVER
            })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(0),
            tokenOut: address(weth),
            amountIn: amountIn,
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: USER_RECEIVER,
            commandType: CommandType.DistributeNative
        });

        bytes memory route = _buildBaseRoute(params, swapData);
        _executeAndVerifySwap(params, route, InvalidCallData.selector);

        vm.stopPrank();
    }

    // ==== Helper Functions ====

    /// @notice Builds swap data for unwrapNative operation
    /// @param params Unwrap parameters
    /// @return Packed swap data with selector and parameters
    function _buildUnwrapSwapData(
        UnwrapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                nativeWrapperFacet.unwrapNative.selector,
                params.destinationAddress
            );
    }

    /// @notice Builds swap data for wrapNative operation
    /// @param params Wrap parameters
    /// @return Packed swap data with selector and parameters
    function _buildWrapSwapData(
        WrapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                nativeWrapperFacet.wrapNative.selector,
                params.wrappedNative,
                params.destinationAddress
            );
    }
}
