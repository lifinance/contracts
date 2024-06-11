// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DexManagerFacet") {}

    function run() public returns (DexManagerFacet deployed) {
        deployed = DexManagerFacet(deploy(type(DexManagerFacet).creationCode));
    }
}
