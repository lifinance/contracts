// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { LDADiamondCutFacet } from "lifi/Periphery/LDA/Facets/LDADiamondCutFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("LDADiamondCutFacet") {}

    function run() public returns (LDADiamondCutFacet deployed) {
        deployed = LDADiamondCutFacet(
            deploy(type(LDADiamondCutFacet).creationCode)
        );
    }
}
