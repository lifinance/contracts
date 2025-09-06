// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    using stdJson for string;

    constructor() DeployLDAScriptBase("CoreRouteFacet") {}

    function run()
        public
        returns (CoreRouteFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CoreRouteFacet(deploy(type(CoreRouteFacet).creationCode));
    }
}
