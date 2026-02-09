// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación DRY: Reimplementa lógica que existe en LibAsset
// Debería usar LibAsset.transferFromNative en lugar de reimplementar
contract BadDRYContract {
    function transferNative(address to, uint256 amount) public {
        // Violación: Reimplementa transferencia nativa que LibAsset ya hace
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }
    
    // Violación: Reimplementa validación que Validatable ya proporciona
    function validateAddress(address addr) public pure returns (bool) {
        return addr != address(0);
        // Debería usar Validatable o helpers existentes
    }
    
    // Violación: Reimplementa swap logic que LibSwap ya maneja
    function executeSwap(address token, uint256 amount) public {
        // Lógica de swap que debería usar LibSwap
    }
}
