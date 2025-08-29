// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { CurveFacet } from "lifi/Periphery/LDA/Facets/CurveFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("CurveFacet") {}

    function run() public returns (CurveFacet deployed) {
        deployed = CurveFacet(deploy(type(CurveFacet).creationCode));
    }
}
