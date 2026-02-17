// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {SomeContract} from "../src/Facets/SomeFacet.sol" // contracts primero (incorrecto)
import {ILiFi} from "../src/Interfaces/ILiFi.sol" // interfaces después (incorrecto)
import {LibAsset} from "../src/Libraries/LibAsset.sol" // libraries después (incorrecto)
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol" // external libs al final (incorrecto)

/// @title BadImportOrder
/// @author LI.FI (https://li.fi)
/// @notice Example contract with incorrect import order and missing semicolons
/// @custom:version 1.0.0
contract BadImportOrder {
    function someFunction() external pure returns (bool) {
        return true;
    }
}
