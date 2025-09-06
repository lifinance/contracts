// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { VelodromeV2Facet } from "lifi/Periphery/LDA/Facets/VelodromeV2Facet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("VelodromeV2Facet") {}

    function run() public returns (VelodromeV2Facet deployed) {
        deployed = VelodromeV2Facet(
            deploy(type(VelodromeV2Facet).creationCode)
        );
    }
}
