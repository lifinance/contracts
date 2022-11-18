// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DiamondLoupeFacet") {}

    function run() public returns (DiamondLoupeFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        address predicted = factory.getDeployed(vm.addr(deployerPrivateKey), salt);
        if (isDeployed()) {
            return DiamondLoupeFacet(predicted);
        }

        deployed = DiamondLoupeFacet(factory.deploy(salt, type(DiamondLoupeFacet).creationCode));

        vm.stopBroadcast();
    }
}
