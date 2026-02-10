// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// Violation: Incorrect import order
// Should be: external libs → interfaces → libraries → contracts
import {SomeContract} from "../src/Facets/SomeFacet.sol" // contracts imported first (incorrect)
import {ILiFi} from "../src/Interfaces/ILiFi.sol" // interfaces imported after contracts (incorrect)
import {LibAsset} from "../src/Libraries/LibAsset.sol" // libraries imported after contracts (incorrect)
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol" // external libs imported last (incorrect)

contract BadImportOrder {
    // Correct order should be:
    // 1. @openzeppelin/contracts/...
    // 2. src/Interfaces/...
    // 3. src/Libraries/...
    // 4. src/Facets/...
}
