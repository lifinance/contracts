// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

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
