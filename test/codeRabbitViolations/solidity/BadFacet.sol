// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {LiFiDiamond} from "../src/LiFiDiamond.sol";

// Violation: Facet does not include the \"Facet\" suffix in its name
// Violation: Missing required internal _startBridge function
// Violation: Missing swapAndStartBridgeTokensVia{FacetName}
// Violation: Missing startBridgeTokensVia{FacetName}
// Violation: Missing nonReentrant modifier
// Violation: Missing refundExcessNative modifier
// Violation: Missing validateBridgeData modifier
contract BadBridgeFacet {
    // Violation: receiverAddress is not the first parameter
    struct BadBridgeData {
        uint256 amount;
        address receiverAddress; // Debería ser primero
    }
    
    // Violation: Does not use LibAsset/LibSwap/LibAllowList
    // Violation: Does not delegate core logic to libraries
    function bridgeTokens(BadBridgeData memory data) public {
        // Inline logic instead of using shared libraries
        // Violation: Does not emit LiFiTransferStarted at the end of _startBridge
    }
}
