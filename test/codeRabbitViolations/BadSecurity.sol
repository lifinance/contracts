// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: No valida inputs externos
// Violación: Bypass de governance - función admin directa sin timelock
contract BadSecurityContract {
    address public owner;
    
    // Violación: Función admin que bypassa timelock/Safe
    function emergencyUpgrade(address newContract) public {
        require(msg.sender == owner, "Not owner");
        // Upgrade directo sin governance
    }
    
    // Violación: No valida parámetros
    function setConfig(uint256 value, address target) public {
        // Sin validación de address(0) o valores inválidos
        // Sin usar helpers de validación existentes
    }
}
