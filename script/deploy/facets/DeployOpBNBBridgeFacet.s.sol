// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OpBNBBridgeFacet } from "lifi/Facets/OpBNBBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OpBNBBridgeFacet") {}

    function run() public returns (OpBNBBridgeFacet deployed) {
        deployed = OpBNBBridgeFacet(
            deploy(type(OpBNBBridgeFacet).creationCode)
        );
    }
}
