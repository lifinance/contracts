// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { LDAOwnershipFacet } from "lifi/Periphery/LDA/Facets/LDAOwnershipFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("LDAOwnershipFacet") {}

    function run() public returns (LDAOwnershipFacet deployed) {
        deployed = LDAOwnershipFacet(
            deploy(type(LDAOwnershipFacet).creationCode)
        );
    }
}
