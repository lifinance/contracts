// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacetPacked") {}

    function run() public returns (HopFacetPacked deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return HopFacetPacked(predicted);
        }

        deployed = HopFacetPacked(factory.deploy(salt, type(HopFacetPacked).creationCode));

        vm.stopBroadcast();
    }
}
