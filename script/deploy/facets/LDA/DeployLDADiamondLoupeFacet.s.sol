// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { LDADiamondLoupeFacet } from "lifi/Periphery/LDA/Facets/LDADiamondLoupeFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("LDADiamondLoupeFacet") {}

    function run() public returns (LDADiamondLoupeFacet deployed) {
        deployed = LDADiamondLoupeFacet(
            deploy(type(LDADiamondLoupeFacet).creationCode)
        );
    }
}
