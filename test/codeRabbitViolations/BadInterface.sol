// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Interface sin prefijo I*
// Violación: Ubicación incorrecta - debería estar en src/Interfaces/
// Violación: Incluye funciones no usadas (debería solo incluir lo usado)
interface BadExternalProtocol {
    function function1() external;
    function function2() external;
    function function3() external;
    function function4() external;
    function function5() external;
    // Muchas funciones que no se usan
}

// Violación: Mezcla interface e implementación en mismo archivo
contract BadImplementation is BadExternalProtocol {
    function function1() external override {}
}
