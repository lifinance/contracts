// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IzumiV3Facet } from "lifi/Periphery/LDA/Facets/IzumiV3Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseDEXFacetWithCallbackTest } from "../BaseDEXFacetWithCallback.t.sol";
import { MockNoCallbackPool } from "../../../utils/MockNoCallbackPool.sol";

/// @title IzumiV3FacetTest
/// @notice Forked + local tests for Izumi V3 pools routed through LDA.
/// @dev Validates swap paths, aggregator/user flows, multi-hop, callback auth, and revert cases.
contract IzumiV3FacetTest is BaseDEXFacetWithCallbackTest {
    /// @notice Facet proxy handle bound to diamond after facet cut.
    IzumiV3Facet internal izumiV3Facet;

    // ==== Types ====

    /// @notice Parameters for a single Izumi V3 swap step.
    /// @param pool Target pool.
    /// @param direction Direction of the swap.
    /// @param destinationAddress Address receiving the proceeds.
    struct IzumiV3SwapParams {
        address pool;
        SwapDirection direction;
        address destinationAddress;
    }

    // ==== Errors ====

    /// @notice Emitted when callback amounts are non-positive (guard against bad pool behavior).
    error IzumiV3SwapCallbackNotPositiveAmount();

    // ==== Setup Functions ====

    /// @notice Selects Base fork and block height used by the tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "base",
            blockNumber: 29831758
        });
    }

    /// @notice Deploys facet and returns swap + callback selectors for diamond cut.
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

    /// @notice Sets `izumiV3Facet` to the diamond proxy.
    function _setFacetInstance(address payable ldaDiamond) internal override {
        izumiV3Facet = IzumiV3Facet(ldaDiamond);
    }

    /// @notice Defines a USDC/WETH/USDB_C path and pools on Base for tests.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913); // USDC
        tokenMid = IERC20(0x4200000000000000000000000000000000000006); // WETH
        tokenOut = IERC20(0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA); // USDB_C
        poolInMid = 0xb92A9A91a9F7E8e6Bb848508A6DaF08f9D718554; // WETH/USDC
        poolMidOut = 0xdb5D62f06EEcEf0Da7506e0700c2f03c57016De5; // WETH/USDB_C
    }

    /// @notice Default amount for USDC (6 decimals) used in tests.
    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 100 * 1e6; // 100 USDC with 6 decimals
    }

    // ==== Callback Test Hooks ====

    /// @notice Chooses which callback to use under the base callback tests.
    function _getCallbackSelector() internal view override returns (bytes4) {
        return izumiV3Facet.swapX2YCallback.selector;
    }

    /// @notice Supplies a no-callback pool for negative tests.
    function _deployNoCallbackPool() internal override returns (address) {
        return address(new MockNoCallbackPool());
    }

    /// @notice Encodes swap payload for callback arming tests.
    /// @param pool Pool to use.
    /// @param destinationAddress Destination address of proceeds.
    function _buildCallbackSwapData(
        address pool,
        address destinationAddress
    ) internal pure override returns (bytes memory) {
        return
            abi.encodePacked(
                IzumiV3Facet.swapIzumiV3.selector,
                pool,
                uint8(1), // direction TOKEN0_TO_TOKEN1
                destinationAddress
            );
    }

    // ==== Test Cases ====

    /// @notice User-funded swap USDC->WETH on poolInMid, sending to USER_RECEIVER.
    function test_CanSwap() public override {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: USER_RECEIVER
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Aggregator-funded swap USDC->WETH on poolInMid to USER_SENDER.
    function test_CanSwap_FromDexAggregator() public override {
        // Test USDC -> WETH
        deal(
            address(tokenIn),
            address(coreRouteFacet),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: USER_SENDER
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn() - 1, // -1 for undrain protection
                minOut: 0,
                sender: address(coreRouteFacet),
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeSelfERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Multi-hop user→aggregator USDC->WETH->USDB_C flow.
    function test_CanSwap_MultiHop() public override {
        // Fund the sender with tokens
        uint256 amountIn = _getDefaultAmountForTokenIn();
        deal(address(tokenIn), USER_SENDER, amountIn);

        // Build first swap data: USDC -> WETH
        bytes memory firstSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token1ToToken0,
                destinationAddress: address(coreRouteFacet)
            })
        );

        // Build second swap data: WETH -> USDB_C
        bytes memory secondSwapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolMidOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_SENDER
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
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: address(coreRouteFacet),
            commandType: CommandType.DistributeUserERC20
        });
        swapData[0] = firstSwapData;

        // Second hop: WETH -> USDB_C
        params[1] = SwapTestParams({
            tokenIn: address(tokenMid),
            tokenOut: address(tokenOut),
            amountIn: 0, // Will be determined by first swap
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DistributeSelfERC20
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        vm.startPrank(USER_SENDER);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route
        );

        vm.stopPrank();
    }

    /// @notice Negative test: callback should revert when amounts are not positive.
    function testRevert_IzumiV3SwapCallbackNotPositiveAmount() public {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.store(
            address(ldaDiamond),
            keccak256("com.lifi.lda.callbackAuthenticator"),
            bytes32(uint256(uint160(poolInMid)))
        );

        vm.prank(poolInMid);
        vm.expectRevert(IzumiV3SwapCallbackNotPositiveAmount.selector);
        izumiV3Facet.swapY2XCallback(0, 0, abi.encode(tokenIn));
    }

    /// @notice Negative test: too-large amount encodings must revert with InvalidCallData.
    function testRevert_FailsIfAmountInIsTooLarge() public {
        deal(address(tokenMid), USER_SENDER, type(uint256).max);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildIzumiV3SwapData(
            IzumiV3SwapParams({
                pool: poolInMid,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_RECEIVER
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenMid),
                tokenOut: address(tokenIn),
                amountIn: type(uint216).max,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_RECEIVER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    // ==== Helper Functions ====

    /// @notice Encodes Izumi V3 swap payloads for route steps.
    /// @param params Pool/direction/destinationAddress.
    /// @return Packed calldata for `swapIzumiV3`.
    function _buildIzumiV3SwapData(
        IzumiV3SwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                izumiV3Facet.swapIzumiV3.selector,
                params.pool,
                uint8(params.direction),
                params.destinationAddress
            );
    }
}
