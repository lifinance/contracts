// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("CoreRouteFacet") {}

    function run() public returns (CoreRouteFacet deployed) {
        deployed = CoreRouteFacet(deploy(type(CoreRouteFacet).creationCode));
    }

    function getConstructorArgs() internal view override returns (bytes memory) {
        // CoreRouteFacet constructor requires _owner parameter
        return abi.encode(deployerAddress);
    }
}
