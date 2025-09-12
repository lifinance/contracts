// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { stdJson } from "forge-std/Script.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CoreRouteFacet") {}

    function run() public returns (CoreRouteFacet deployed) {
        deployed = CoreRouteFacet(deploy(type(CoreRouteFacet).creationCode));
    }
}
