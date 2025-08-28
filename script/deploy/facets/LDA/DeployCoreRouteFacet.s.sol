// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("CoreRouteFacet") {}

    function run() public returns (CoreRouteFacet deployed) {
        deployed = CoreRouteFacet(deploy(type(CoreRouteFacet).creationCode));
    }
}
