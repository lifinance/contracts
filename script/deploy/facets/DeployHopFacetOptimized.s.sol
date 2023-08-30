// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacetOptimized") {}

    function run() public returns (HopFacetOptimized deployed) {
        deployed = HopFacetOptimized(
            deploy(type(HopFacetOptimized).creationCode)
        );
    }
}
