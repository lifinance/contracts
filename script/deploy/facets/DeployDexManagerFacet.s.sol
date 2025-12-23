// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DexManagerFacet") {}

    function run() public returns (DexManagerFacet deployed) {
        deployed = DexManagerFacet(deploy(type(DexManagerFacet).creationCode));
    }
}
