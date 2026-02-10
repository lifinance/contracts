// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Facet that does not handle positive slippage correctly
contract BadSlippageFacet {
    function swapAndStartBridge(uint256 amount, uint256 minAmountOut) public {
        // Violation: Does not update minAmountOut after _depositAndSwap
        // Should adjust minAmountOut proportionally after
        // _depositAndSwap updates _bridgeData.minAmount
        // See AcrossFacetV4.sol lines 137-147 for a correct reference
        
        // Simulate _depositAndSwap updating minAmount
        uint256 updatedMinAmount = amount * 105 / 100; // +5% slippage positivo
        
        // Violation: Does not adjust bridge minAmountOut to the updatedMinAmount
        bridgeProtocol.bridge(amount, minAmountOut); // Uses original minAmountOut instead of updatedMinAmount
    }
}
