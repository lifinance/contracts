// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { IzumiV3Facet } from "lifi/Periphery/LDA/Facets/IzumiV3Facet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("IzumiV3Facet") {}

    function run() public returns (IzumiV3Facet deployed) {
        deployed = IzumiV3Facet(deploy(type(IzumiV3Facet).creationCode));
    }
}
