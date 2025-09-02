// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { LDAPeripheryRegistryFacet } from "lifi/Periphery/LDA/Facets/LDAPeripheryRegistryFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("LDAPeripheryRegistryFacet") {}

    function run() public returns (LDAPeripheryRegistryFacet deployed) {
        deployed = LDAPeripheryRegistryFacet(
            deploy(type(LDAPeripheryRegistryFacet).creationCode)
        );
    }
}
