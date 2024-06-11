// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("AccessManagerFacet") {}

    function run() public returns (AccessManagerFacet deployed) {
        deployed = AccessManagerFacet(
            deploy(type(AccessManagerFacet).creationCode)
        );
    }
}
