// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BaseDexFacetTest } from "../BaseDexFacet.t.sol";
import { SyncSwapV2Facet } from "lifi/Periphery/Lda/Facets/SyncSwapV2Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

contract SyncSwapV2FacetTest is BaseDexFacetTest {
    SyncSwapV2Facet internal syncSwapV2Facet;

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

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_LINEA",
            blockNumber: 20077881
        });
    }

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

    function _setFacetInstance(
        address payable facetAddress
    ) internal override {
        syncSwapV2Facet = SyncSwapV2Facet(facetAddress);
    }

    /// @notice Single‐pool swap: USER sends WETH → receives USDC
    function test_CanSwap() public override {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V1,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        // Record balances before swap
        uint256 inBefore = WETH.balanceOf(USER_SENDER);
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
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
        WETH.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V2,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 0,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        // Record balances before swap
        uint256 inBefore = WETH.balanceOf(USER_SENDER);
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        // Execute the swap (minOut = 0 for test)
        coreRouteFacet.processRoute(
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
        deal(address(WETH), address(ldaDiamond), amountIn);

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V1,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn - 1, // Account for slot-undrain
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: true
            }),
            swapData
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        coreRouteFacet.processRoute(
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
        deal(address(WETH), address(ldaDiamond), amountIn);

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

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn - 1, // Account for slot-undrain
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: true
            }),
            swapData
        );

        // Subtract 1 to protect against slot‐undrain
        uint256 swapAmount = amountIn - 1;
        uint256 outBefore = USDC.balanceOf(USER_SENDER);

        coreRouteFacet.processRoute(
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
        WETH.approve(address(ldaDiamond), amountIn);

        // Build swap data for both hops
        bytes memory firstSwapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V1,
                to: SYNC_SWAP_VAULT,
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory secondSwapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_USDT_POOL_V1,
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
            tokenIn: address(WETH),
            tokenOut: address(USDC),
            amountIn: amountIn,
            sender: USER_SENDER,
            recipient: SYNC_SWAP_VAULT,
            isAggregatorFunds: false // ProcessUserERC20
        });
        swapData[0] = firstSwapData;

        // Second hop: USDC -> USDT
        params[1] = SwapTestParams({
            tokenIn: address(USDC),
            tokenOut: address(USDT),
            amountIn: 0, // Not used in ProcessOnePool
            sender: USER_SENDER,
            recipient: USER_SENDER,
            isAggregatorFunds: true // ProcessOnePool
        });
        swapData[1] = secondSwapData;

        bytes memory route = _buildMultiHopRoute(params, swapData);

        // Use _executeAndVerifySwap with first and last token of the chain
        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDT),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            route
        );

        vm.stopPrank();
    }

    function testRevert_V1PoolMissingVaultAddress() public {
        // Transfer 1 000 WETH from whale to USER_SENDER
        uint256 amountIn = 1_000 * 1e18;
        deal(address(WETH), USER_SENDER, amountIn);

        vm.startPrank(USER_SENDER);
        WETH.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V1,
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: address(0) // Invalid vault address
            })
        );

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
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
        WETH.approve(address(ldaDiamond), amountIn);

        bytes memory swapData = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: address(0),
                to: address(USER_SENDER),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory routeWithInvalidPool = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapData
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            routeWithInvalidPool
        );

        bytes memory swapDataWithInvalidRecipient = _buildSyncSwapV2SwapData(
            SyncSwapV2SwapParams({
                pool: USDC_WETH_POOL_V1,
                to: address(0),
                withdrawMode: 2,
                isV1Pool: 1,
                vault: SYNC_SWAP_VAULT
            })
        );

        bytes memory routeWithInvalidRecipient = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: amountIn,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapDataWithInvalidRecipient
        );

        // Expect revert with InvalidCallData
        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(WETH),
            amountIn,
            address(USDC),
            0,
            USER_SENDER,
            routeWithInvalidRecipient
        );

        vm.stopPrank();
    }

    function testRevert_InvalidWithdrawMode() public {
        vm.startPrank(USER_SENDER);

        bytes
            memory swapDataWithInvalidWithdrawMode = _buildSyncSwapV2SwapData(
                SyncSwapV2SwapParams({
                    pool: USDC_WETH_POOL_V1,
                    to: address(USER_SENDER),
                    withdrawMode: 3,
                    isV1Pool: 1,
                    vault: SYNC_SWAP_VAULT
                })
            );

        bytes memory routeWithInvalidWithdrawMode = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                amountIn: 1, // Arbitrary amount for this test
                sender: USER_SENDER,
                recipient: USER_SENDER,
                isAggregatorFunds: false
            }),
            swapDataWithInvalidWithdrawMode
        );

        // Expect revert with InvalidCallData because withdrawMode is invalid
        vm.expectRevert(InvalidCallData.selector);
        coreRouteFacet.processRoute(
            address(WETH),
            1,
            address(USDC),
            0,
            USER_SENDER,
            routeWithInvalidWithdrawMode
        );

        vm.stopPrank();
    }

    struct SyncSwapV2SwapParams {
        address pool;
        address to;
        uint8 withdrawMode;
        uint8 isV1Pool;
        address vault;
    }

    function _buildSyncSwapV2SwapData(
        SyncSwapV2SwapParams memory params
    ) internal returns (bytes memory) {
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
