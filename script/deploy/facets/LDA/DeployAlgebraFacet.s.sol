// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { AlgebraFacet } from "lifi/Periphery/LDA/Facets/AlgebraFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("AlgebraFacet") {}

    function run() public returns (AlgebraFacet deployed) {
        deployed = AlgebraFacet(deploy(type(AlgebraFacet).creationCode));
    }
}
