// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { LDADiamondCutFacet } from "lifi/Periphery/LDA/Facets/LDADiamondCutFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("LDADiamondCutFacet") {}

    function run() public returns (LDADiamondCutFacet deployed) {
        deployed = LDADiamondCutFacet(
            deploy(type(LDADiamondCutFacet).creationCode)
        );
    }
}
