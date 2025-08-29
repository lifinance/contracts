// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { UniV3StyleFacet } from "lifi/Periphery/LDA/Facets/UniV3StyleFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("UniV3StyleFacet") {}

    function run() public returns (UniV3StyleFacet deployed) {
        deployed = UniV3StyleFacet(deploy(type(UniV3StyleFacet).creationCode));
    }
}
