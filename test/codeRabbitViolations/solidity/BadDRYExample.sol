// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// DRY violation: re-implements logic that already exists in LibAsset
// Should use LibAsset.transferFromNative instead of re-implementing native transfers
contract BadDRYContract {
    function transferNative(address to, uint256 amount) public {
        // Violation: re-implements native transfer logic that LibAsset already provides
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }
    
    // Violation: re-implements validation that Validatable (or existing helpers) already provide
    function validateAddress(address addr) public pure returns (bool) {
        return addr != address(0);
        // Should use Validatable or existing validation helpers instead
    }
    
    // Violation: re-implements swap logic that LibSwap already handles
    function executeSwap(address token, uint256 amount) public {
        // Swap logic that should delegate to LibSwap instead of being re-implemented
    }
}
