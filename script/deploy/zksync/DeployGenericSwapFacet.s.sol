// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("GenericSwapFacet") {}

    function run() public returns (GenericSwapFacet deployed) {
        deployed = GenericSwapFacet(
            deploy(type(GenericSwapFacet).creationCode)
        );
    }
}
