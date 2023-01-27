// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("AccessManagerFacet") {}

    function run() public returns (AccessManagerFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return AccessManagerFacet(predicted);
        }

        deployed = AccessManagerFacet(
            factory.deploy(salt, type(AccessManagerFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
