// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { KatanaV3Facet } from "lifi/Periphery/LDA/Facets/KatanaV3Facet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseDEXFacetTest } from "../BaseDEXFacet.t.sol";

/// @title KatanaV3FacetTest
/// @notice Ronin Katana V3
contract KatanaV3FacetTest is BaseDEXFacetTest {
    /// @notice Facet proxy bound to the diamond after setup.
    KatanaV3Facet internal katanaV3Facet;

    // ==== Types ====

    /// @notice Swap data payload packed for KatanaV3Facet.
    struct KatanaV3SwapData {
        address pool;
        SwapDirection direction;
        address destinationAddress;
    }

    // ==== Setup Functions ====

    /// @notice Picks Optimism fork and block height.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "ronin",
            blockNumber: 47105304
        });
    }

    /// @notice Deploys facet and returns its swap selector.
    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        katanaV3Facet = new KatanaV3Facet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = KatanaV3Facet.swapKatanaV3.selector;
        return (address(katanaV3Facet), functionSelectors);
    }

    /// @notice Sets the facet instance to the diamond proxy.
    function _setFacetInstance(address payable ldaDiamond) internal override {
        katanaV3Facet = KatanaV3Facet(ldaDiamond);
    }

    /// @notice Assigns tokens used in tests; pool addresses are resolved per-test from the router.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc); // USDC
        tokenOut = IERC20(0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4); // WRAPPED_RON
        poolInOut = 0x392d372F2A51610E9AC5b741379D5631Ca9A1c7f; // USDC_WRAPPED_RON_POOL
    }

    /// @notice Default amount for 6-decimal tokens on Optimism.
    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }

    // ==== Test Cases ====

    function test_CanSwap() public override {
        // Transfer 1 000 crvUSD from whale to USER_SENDER
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildKatanaV3SwapData(
            KatanaV3SwapData({
                pool: poolInOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: address(USER_SENDER)
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
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
        // Fund the aggregator with 1000 USDC
        deal(
            address(tokenIn),
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildKatanaV3SwapData(
            KatanaV3SwapData({
                pool: poolInOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: address(USER_SENDER)
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
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
        // SKIPPED: KatanaV3 multi-hop unsupported due to AS requirement.
        // KatanaV3 (being a similar implementation to UniV3) does not support a "one-pool" second hop today,
        // because the aggregator (ProcessOnePool) always passes amountSpecified = 0 into
        // the pool.swap call. UniV3-style pools immediately revert on
        // require(amountSpecified != 0, 'AS'), so you can't chain two V3 pools in a single processRoute invocation.
    }

    function testRevert_KatanaV3InvalidPool() public {
        vm.startPrank(USER_SENDER);

        // build route with invalid pool address
        bytes memory route = _buildKatanaV3SwapData(
            KatanaV3SwapData({
                pool: address(0),
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: USER_SENDER
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    function testRevert_KatanaV3InvalidRecipient() public {
        vm.startPrank(USER_SENDER);

        // build route with invalid recipient
        bytes memory route = _buildKatanaV3SwapData(
            KatanaV3SwapData({
                pool: poolInOut,
                direction: SwapDirection.Token0ToToken1,
                destinationAddress: address(0) // invalid recipient
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route,
            InvalidCallData.selector
        );

        vm.stopPrank();
    }

    /// @notice Empty test as KatanaV3 does not use callbacks for regular swaps
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    /// @dev Note: While KatanaV3 has flashloan callbacks, they are separate from swap callbacks
    function testRevert_CallbackFromUnexpectedSender() public override {
        // KatanaV3 does not use callbacks for swaps - test intentionally empty
    }

    /// @notice Empty test as KatanaV3 does not use callbacks for regular swaps
    /// @dev Explicitly left empty as this DEX's architecture doesn't require callback verification
    /// @dev Note: While KatanaV3 has flashloan callbacks, they are separate from swap callbacks
    function testRevert_SwapWithoutCallback() public override {
        // KatanaV3 does not use callbacks for swaps - test intentionally empty
    }

    // ==== Helper Functions ====

    /// @notice Encodes swap payload for KatanaV3Facet.swapKatanaV3.
    /// @param params pool/direction/destinationAddress/callback status.
    /// @return Packed bytes payload.
    function _buildKatanaV3SwapData(
        KatanaV3SwapData memory params
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                KatanaV3Facet.swapKatanaV3.selector,
                params.pool,
                uint8(params.direction),
                params.destinationAddress
            );
    }
}
