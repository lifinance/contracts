// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacet") {}

    function run() public returns (HopFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return HopFacet(predicted);
        }

        deployed = HopFacet(factory.deploy(salt, type(HopFacet).creationCode));

        vm.stopBroadcast();
    }
}
