// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("StandardizedCallFacetFacet") {}

    function run() public returns (StandardizedCallFacet deployed) {
        deployed = StandardizedCallFacet(
            deploy(type(StandardizedCallFacet).creationCode)
        );
    }
}
