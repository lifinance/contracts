// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { AttestedBridgeFacet } from "lifi/Facets/AttestedBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("AttestedBridgeFacet") {}

    function run() public returns (AttestedBridgeFacet deployed) {
        deployed = AttestedBridgeFacet(
            deploy(type(AttestedBridgeFacet).creationCode)
        );
    }
}
