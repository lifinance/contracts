// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Inline assembly without documentation or justification
// Violation: Does not use existing optimized libraries (Solady/Solmate)
contract BadGasContract {
    function transfer(address to, uint256 amount) public {
        // Violation: Assembly block without explanation of why it is required
        assembly {
            // Assembly code without comments
        }
        
        // Violation: Re-implements logic that already exists in optimized libraries
        // Should use SafeTransferLib from Solady (or similar) instead
    }
}
