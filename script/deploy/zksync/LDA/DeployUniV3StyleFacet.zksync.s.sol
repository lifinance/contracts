// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UniV3StyleFacet } from "lifi/Periphery/LDA/Facets/UniV3StyleFacet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("UniV3StyleFacet") {}

    function run() public returns (UniV3StyleFacet deployed) {
        deployed = UniV3StyleFacet(deploy(type(UniV3StyleFacet).creationCode));
    }
}
