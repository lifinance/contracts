// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { KatanaV3Facet } from "lifi/Periphery/LDA/Facets/KatanaV3Facet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("KatanaV3Facet") {}

    function run() public returns (KatanaV3Facet deployed) {
        deployed = KatanaV3Facet(deploy(type(KatanaV3Facet).creationCode));
    }
}
