// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("UniV3StyleFacet") {}

    function run() public returns (UniV3StyleFacet deployed) {
        deployed = UniV3StyleFacet(deploy(type(UniV3StyleFacet).creationCode));
    }
}
