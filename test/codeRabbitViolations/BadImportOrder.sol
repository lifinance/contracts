// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violación: Import order incorrecto
// Debería ser: external libs → interfaces → libraries → contracts
import {SomeContract} from "../src/Facets/SomeFacet.sol" // contracts primero (incorrecto)
import {ILiFi} from "../src/Interfaces/ILiFi.sol" // interfaces después (incorrecto)
import {LibAsset} from "../src/Libraries/LibAsset.sol" // libraries después (incorrecto)
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol" // external libs al final (incorrecto)

contract BadImportOrder {
    // Orden correcto debería ser:
    // 1. @openzeppelin/contracts/...
    // 2. src/Interfaces/...
    // 3. src/Libraries/...
    // 4. src/Facets/...
}
