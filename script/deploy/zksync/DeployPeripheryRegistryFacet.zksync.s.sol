// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("PeripheryRegistryFacet") {}

    function run() public returns (PeripheryRegistryFacet deployed) {
        deployed = PeripheryRegistryFacet(
            deploy(type(PeripheryRegistryFacet).creationCode)
        );
    }
}
