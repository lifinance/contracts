// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";
import { SwapCallbackNotExecuted } from "lifi/Errors/GenericErrors.sol";
import { BaseDexFacetTest } from "./BaseDexFacet.t.sol";
import { MockNoCallbackPool } from "../../utils/MockNoCallbackPool.sol";

abstract contract BaseDexFacetWithCallbackTest is BaseDexFacetTest {
    // Each DEX with callback must implement these hooks
    function _getCallbackSelector() internal virtual returns (bytes4);
    function _buildCallbackSwapData(
        address pool,
        address recipient
    ) internal virtual returns (bytes memory);

    function _deployNoCallbackPool() internal virtual returns (address) {
        return address(new MockNoCallbackPool());
    }

    function testRevert_CallbackFromUnexpectedSender()
        public
        virtual
        override
    {
        // No swap has armed the guard; expected == address(0)
        vm.startPrank(USER_SENDER);
        vm.expectRevert(LibCallbackManager.UnexpectedCallbackSender.selector);
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
