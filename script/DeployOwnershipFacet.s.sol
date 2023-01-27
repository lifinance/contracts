// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OwnershipFacet") {}

    function run() public returns (OwnershipFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return OwnershipFacet(predicted);
        }

        deployed = OwnershipFacet(
            factory.deploy(salt, type(OwnershipFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
