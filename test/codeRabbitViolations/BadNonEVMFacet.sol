// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Facet con soporte non-EVM pero validación incorrecta
contract BadNonEVMFacet {
    struct BadBridgeData {
        bytes32 receiverAddress; // Para non-EVM
    }
    
    function startBridge(BadBridgeData memory data) public {
        // Violación: No valida que receiverAddress != bytes32(0) para non-EVM chains
        // Debería revertir con InvalidNonEVMReceiver() si es cero
        if (data.receiverAddress == bytes32(0)) {
            // Solo requiere, debería usar error específico
            require(false, "Invalid receiver");
        }
        
        // Violación: No emite BridgeToNonEVMChainBytes32 para non-EVM chains
        // Debería emitir con transactionId, destinationChainId, non-EVM receiver
    }
}
