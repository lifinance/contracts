// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("MegaETHBridgeFacet") {}

    function run() public returns (MegaETHBridgeFacet deployed) {
        deployed = MegaETHBridgeFacet(
            deploy(type(MegaETHBridgeFacet).creationCode)
        );
    }
}
