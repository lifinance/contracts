// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { AlgebraFacet } from "lifi/Periphery/Lda/Facets/AlgebraFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("AlgebraFacet") {}

    function run() public returns (AlgebraFacet deployed) {
        deployed = AlgebraFacet(deploy(type(AlgebraFacet).creationCode));
    }
}
