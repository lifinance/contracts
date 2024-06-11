// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DiamondCutFacet") {}

    function run() public returns (DiamondCutFacet deployed) {
        deployed = DiamondCutFacet(deploy(type(DiamondCutFacet).creationCode));
    }
}
