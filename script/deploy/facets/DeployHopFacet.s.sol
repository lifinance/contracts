// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacet") {}

    function run() public returns (HopFacet deployed) {
        deployed = HopFacet(deploy(type(HopFacet).creationCode));
    }
}
