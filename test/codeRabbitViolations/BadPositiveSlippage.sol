// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Facet que no maneja positive slippage correctamente
contract BadSlippageFacet {
    function swapAndStartBridge(uint256 amount, uint256 minAmountOut) public {
        // Violación: No actualiza minAmountOut después de _depositAndSwap
        // Debería ajustar minAmountOut proporcionalmente después de que
        // _depositAndSwap actualice _bridgeData.minAmount
        // Ver AcrossFacetV4.sol lines 137-147 para referencia
        
        // Simula _depositAndSwap que actualiza minAmount
        uint256 updatedMinAmount = amount * 105 / 100; // +5% slippage positivo
        
        // Violación: No ajusta minAmountOut del bridge proporcionalmente
        bridgeProtocol.bridge(amount, minAmountOut); // Usa minAmountOut original, no actualizado
    }
}
