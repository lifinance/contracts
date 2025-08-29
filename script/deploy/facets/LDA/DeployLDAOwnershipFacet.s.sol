// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { LDAOwnershipFacet } from "lifi/Periphery/LDA/Facets/LDAOwnershipFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("LDAOwnershipFacet") {}

    function run() public returns (LDAOwnershipFacet deployed) {
        deployed = LDAOwnershipFacet(
            deploy(type(LDAOwnershipFacet).creationCode)
        );
    }
}
