// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Assembly inline sin documentación ni justificación
// Violación: No usa librerías optimizadas existentes (Solady/Solmate)
contract BadGasContract {
    function transfer(address to, uint256 amount) public {
        // Violación: Assembly sin documentar por qué es necesario
        assembly {
            // Código assembly sin comentarios
        }
        
        // Violación: Reimplementa lógica que existe en librerías optimizadas
        // Debería usar SafeTransferLib de solady
    }
}
