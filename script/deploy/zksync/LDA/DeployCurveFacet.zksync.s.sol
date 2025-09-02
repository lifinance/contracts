// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { CurveFacet } from "lifi/Periphery/LDA/Facets/CurveFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("CurveFacet") {}

    function run() public returns (CurveFacet deployed) {
        deployed = CurveFacet(deploy(type(CurveFacet).creationCode));
    }
}
