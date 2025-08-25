// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibCallbackAuthenticator } from "lifi/Libraries/LibCallbackAuthenticator.sol";
import { SwapCallbackNotExecuted } from "lifi/Periphery/LDA/Errors/Errors.sol";
import { BaseDEXFacetTest } from "./BaseDEXFacet.t.sol";
import { MockNoCallbackPool } from "../../utils/MockNoCallbackPool.sol";

/// @title BaseDEXFacetWithCallbackTest
/// @notice Base harness for testing DEX facets that rely on swap callbacks.
/// @dev Provides callback selector/data hooks and two negative tests:
///      - unexpected callback sender
///      - swap path where pool never calls back (should revert)
abstract contract BaseDEXFacetWithCallbackTest is BaseDEXFacetTest {
    /// @notice Returns the callback selector used by the DEX under test.
    /// @return selector Function selector for the DEX's swap callback.
    function _getCallbackSelector() internal virtual returns (bytes4);

    /// @notice Builds swap data that arms callback verification for the DEX under test.
    /// @param pool Pool expected to invoke the callback.
    /// @param recipient Receiver of swap proceeds.
    /// @return swapData Encoded payload that triggers the DEX callback path.
    function _buildCallbackSwapData(
        address pool,
        address recipient
    ) internal virtual returns (bytes memory);

    /// @notice Provides a mock pool that never performs the callback (negative path).
    /// @return pool Address of a pool that will not call the callback.
    function _deployNoCallbackPool() internal virtual returns (address) {
        return address(new MockNoCallbackPool());
    }

    /// @notice Reverts when the callback is invoked by an unexpected sender.
    /// @dev No swap is performed beforehand, so the authenticator should hold address(0) and reject.
    function testRevert_CallbackFromUnexpectedSender()
        public
        virtual
        override
    {
        // No swap has armed the guard; expected == address(0)
        vm.startPrank(USER_SENDER);
        vm.expectRevert(
            LibCallbackAuthenticator.UnexpectedCallbackSender.selector
        );
        (bool ok, ) = address(ldaDiamond).call(
            abi.encodeWithSelector(
                _getCallbackSelector(),
                int256(1),
                int256(1),
                bytes("")
            )
        );
        ok;
        vm.stopPrank();
    }

    /// @notice Reverts when the swap path never executes the callback.
    /// @dev Uses a mock pool that does not call back; the aggregator remains armed and must revert.
    function testRevert_SwapWithoutCallback() public virtual override {
        // Pool that does not call back (facet-specific implementation)
        address mockPool = _deployNoCallbackPool();

        // Setup test params
        deal(address(tokenIn), USER_SENDER, _getDefaultAmountForTokenIn());

        vm.startPrank(USER_SENDER);
        tokenIn.approve(address(ldaDiamond), _getDefaultAmountForTokenIn());

        // Build facet-specific swap data
        bytes memory swapData = _buildCallbackSwapData(mockPool, USER_SENDER);

        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            swapData
        );

        // Should revert because pool doesn't call back, leaving armed state
        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            route,
            SwapCallbackNotExecuted.selector
        );

        vm.stopPrank();
    }
}
