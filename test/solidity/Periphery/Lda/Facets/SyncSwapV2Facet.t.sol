// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseDEXFacetTest } from "../BaseDEXFacet.t.sol";
import { SyncSwapV2Facet } from "lifi/Periphery/LDA/Facets/SyncSwapV2Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

/// @title SyncSwapV2FacetTest
/// @notice Linea SyncSwap V2 tests via LDA route; includes both v1 and v2 pool wiring.
/// @dev Verifies single-hop, aggregator flow, multi-hop (with DispatchSinglePoolSwap), and revert paths.
contract SyncSwapV2FacetTest is BaseDEXFacetTest {
    /// @notice Facet proxy for swaps bound to the diamond after setup.
    SyncSwapV2Facet internal syncSwapV2Facet;

    /// @notice SyncSwap vault address used by V1 pools.
    address internal constant SYNC_SWAP_VAULT =
        address(0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B);

    /// @notice A Linea v2 pool used by specific tests.
    address internal constant USDC_WETH_POOL_V2 =
        address(0xDDed227D71A096c6B5D87807C1B5C456771aAA94);

    /// @notice Selects Linea fork and block height used by tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "linea",
            blockNumber: 20077881
        });
    }

    /// @notice Deploys SyncSwapV2Facet and returns its swap selector for diamond cut.
    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        syncSwapV2Facet = new SyncSwapV2Facet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = syncSwapV2Facet.swapSyncSwapV2.selector;
        return (address(syncSwapV2Facet), functionSelectors);
    }

    /// @notice Sets the facet instance to the diamond proxy after facet cut.
    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        syncSwapV2Facet = SyncSwapV2Facet(facetAddress);
    }

    /// @notice Defines tokens and pools used by tests (WETH/USDC/USDT).
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f); // WETH
        tokenMid = IERC20(0x176211869cA2b568f2A7D4EE941E073a821EE1ff); // USDC
        tokenOut = IERC20(0xA219439258ca9da29E9Cc4cE5596924745e12B93); // USDT
        poolInMid = 0x5Ec5b1E9b1Bd5198343ABB6E55Fb695d2F7Bb308; // WETH-USDC V1
        poolMidOut = 0x258d5f860B11ec73Ee200eB14f1b60A3B7A536a2; // USDC-USDT V1
    }

    /// @notice Single‐pool swap: USER sends WETH → receives USDC.
    function test_CanSwap() public override {
        // Transfer 1 000 WETH from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: poolInMid,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
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

    /// @notice User-funded swap on a V2 pool variant.
    function test_CanSwap_PoolV2() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V2,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 0,
                vault: SYNC_SWAP_VAULT
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

    /// @notice Aggregator-funded swap on a V1 pool; uses amountIn-1 for undrain protection.
    function test_CanSwap_FromDexAggregator() public override {
        // Fund the aggregator with 1 000 WETH
        deal(
            address(tokenIn),
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: poolInMid,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn() - 1, // Account for slot-undrain
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeSelfERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Aggregator-funded swap on a V2 pool; same undrain behavior.
    function test_CanSwap_FromDexAggregator_PoolV2() public {
        // Fund the aggregator with 1 000 WETH
        deal(
            address(tokenIn),
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V2,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 0,
                vault: SYNC_SWAP_VAULT
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenMid),
                amountIn: _getDefaultAmountForTokenIn() - 1, // Account for slot-undrain
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeSelfERC20
            }),
            swapData
        );

        vm.stopPrank();
    }

    /// @notice Multi-hop WETH->USDC (v1) then USDC->USDT (v1) where hop2 consumes hop1 outputs.
    function test_CanSwap_MultiHop() public override {
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), _getDefaultAmountForTokenIn());

        // Build swap data for both hops
        bytes memory firstSwapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: poolInMid,
                to: SYNC_SWAP_VAULT,
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory secondSwapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: poolMidOut,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        // Prepare params for both hops
        SwapTestParams[] memory params = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        // First hop: WETH -> USDC
        params[0] = SwapTestParams({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenMid),
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: SYNC_SWAP_VAULT,
            commandType: CommandType.DistributeUserERC20
        });
        swapData[0] = firstSwapData;

        // Second hop: USDC -> USDT
        params[1] = SwapTestParams({
            tokenIn: address(tokenMid),
            tokenOut: address(tokenOut),
            amountIn: 0, // Not used in DispatchSinglePoolSwap
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DistributeSelfERC20
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        // Use _executeAndVerifySwap with first and last token of the chain
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

    /// @notice V1 pools require non-zero vault; zero must revert.
    function testRevert_V1PoolMissingVaultAddress() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: poolInOut,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: address(0) // Invalid vault address
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Invalid pool/destinationAddress combinations should revert.
    function testRevert_InvalidPoolOrDestinationAddress() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapDataWithInvalidPool = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: address(0),
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER, // Send to next pool
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataWithInvalidPool,
            InvalidCallData.selector
        );

        bytes
            memory swapDataWithInvalidDestinationAddress = _buildSyncSwapV2SwapData(
                SyncSwapV2SwapParams({
                    pool: poolInOut,
                    to: address(0),
                    withdrawMode: 2,
                    isV1Pool: 1,
                    vault: SYNC_SWAP_VAULT
                })
            );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataWithInvalidDestinationAddress,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Only withdrawMode 0/1/2 are supported; invalid modes must revert.
    function testRevert_InvalidWithdrawMode() public {
        vm.startPrank(USER_SENDER);

        bytes
            memory swapDataWithInvalidWithdrawMode = _buildSyncSwapV2SwapData(
                SyncSwapV2SwapParams({
                    pool: poolInOut,
                    to: address(USER_SENDER),
                    withdrawMode: 3,
                    isV1Pool: 1,
                    vault: SYNC_SWAP_VAULT
                })
            );

        _buildRouteAndExecuteSwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: 1,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapDataWithInvalidWithdrawMode,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Empty test as SyncSwapV2 does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_CallbackFromUnexpectedSender() public override {
        // SyncSwapV2 does not use callbacks - test intentionally empty
    }

    /// @notice Empty test as SyncSwapV2 does not use callbacks
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    function testRevert_SwapWithoutCallback() public override {
        // SyncSwapV2 does not use callbacks - test intentionally empty
    }

    /// @notice SyncSwap V2 swap parameter shape used for `swapSyncSwapV2`.
    struct SyncSwapV2SwapParams {
        address pool;
        address to;
        uint8 withdrawMode;
        uint8 isV1Pool;
        address vault;
    }

    /// @notice Builds SyncSwapV2 swap payload for route steps.
    /// @param params pool/to/withdrawMode/isV1Pool/vault tuple.
    function _buildSyncSwapV2SwapData(
        SyncSwapV2SwapParams memory params
    ) internal view returns (bytes memory) {
        return
            abi.encodePacked(
                syncSwapV2Facet.swapSyncSwapV2.selector,
                params.pool,
                params.to,
                params.withdrawMode,
                params.isV1Pool,
                params.vault
            );
    }
}
