// Violación: Falta SPDX license, pragma incorrecto, blank line entre SPDX y pragma
pragma solidity ^0.8.17;

// Violación: NatSpec incompleto - falta @title, @author, @notice, @custom:version
contract BadSolidityContract {
    // Violación: Naming - constante debería ser CONSTANT_CASE
    uint256 public constant maxAmount = 1000;
    
    // Violación: Naming - parámetro sin underscore
    function transfer(uint256 amount) public {
        // Violación: Blank lines - falta blank line entre secciones lógicas
        uint256 balance = 100;
        emit Transfer(amount);
    }
    
    // Violación: Event - usando ContractName.EventName syntax (no permitido en 0.8.17)
    event BadSolidityContract.Transfer(uint256 amount);
}
