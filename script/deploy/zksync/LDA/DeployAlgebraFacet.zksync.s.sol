// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AlgebraFacet } from "lifi/Periphery/LDA/Facets/AlgebraFacet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("AlgebraFacet") {}

    function run() public returns (AlgebraFacet deployed) {
        deployed = AlgebraFacet(deploy(type(AlgebraFacet).creationCode));
    }
}
