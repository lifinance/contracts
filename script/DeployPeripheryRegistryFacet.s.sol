// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("PeripheryRegistryFacet") {}

    function run() public returns (PeripheryRegistryFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return PeripheryRegistryFacet(predicted);
        }

        deployed = PeripheryRegistryFacet(factory.deploy(salt, type(PeripheryRegistryFacet).creationCode));

        vm.stopBroadcast();
    }
}
