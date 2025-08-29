// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { LDADiamondLoupeFacet } from "lifi/Periphery/LDA/Facets/LDADiamondLoupeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("LDADiamondLoupeFacet") {}

    function run() public returns (LDADiamondLoupeFacet deployed) {
        deployed = LDADiamondLoupeFacet(
            deploy(type(LDADiamondLoupeFacet).creationCode)
        );
    }
}
