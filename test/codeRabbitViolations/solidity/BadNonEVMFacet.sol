// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Facet with non-EVM support but incorrect validation
contract BadNonEVMFacet {
    struct BadBridgeData {
        bytes32 receiverAddress; // Para non-EVM
    }
    
    function startBridge(BadBridgeData memory data) public {
        // Violation: Does not validate that receiverAddress != bytes32(0) for non-EVM chains
        // Should revert with InvalidNonEVMReceiver() if it is zero
        if (data.receiverAddress == bytes32(0)) {
            // Solo requiere, debería usar error específico
            require(false, "Invalid receiver");
        }
        
        // Violation: Does not emit BridgeToNonEVMChainBytes32 for non-EVM chains
        // Should emit with transactionId, destinationChainId, and non-EVM receiver
    }
}
