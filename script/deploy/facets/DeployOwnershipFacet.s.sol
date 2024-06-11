// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OwnershipFacet") {}

    function run() public returns (OwnershipFacet deployed) {
        deployed = OwnershipFacet(deploy(type(OwnershipFacet).creationCode));
    }
}
