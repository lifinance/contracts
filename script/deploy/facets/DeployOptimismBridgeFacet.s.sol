// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OptimismBridgeFacet") {}

    function run() public returns (OptimismBridgeFacet deployed) {
        deployed = OptimismBridgeFacet(
            deploy(type(OptimismBridgeFacet).creationCode)
        );
    }
}
