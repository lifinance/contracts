// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("MultichainFacet") {}

    function run() public returns (MultichainFacet deployed) {
        deployed = MultichainFacet(deploy(type(MultichainFacet).creationCode));
    }
}
