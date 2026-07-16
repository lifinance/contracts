// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { CalldataVerificationFacet } from "lifi/Facets/CalldataVerificationFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("CalldataVerificationFacetFacet") {}

    function run() public returns (CalldataVerificationFacet deployed) {
        deployed = CalldataVerificationFacet(
            deploy(type(CalldataVerificationFacet).creationCode)
        );
    }
}
