// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { VelodromeV2Facet } from "lifi/Periphery/Lda/Facets/VelodromeV2Facet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("VelodromeV2Facet") {}

    function run() public returns (VelodromeV2Facet deployed) {
        deployed = VelodromeV2Facet(
            deploy(type(VelodromeV2Facet).creationCode)
        );
    }
}
