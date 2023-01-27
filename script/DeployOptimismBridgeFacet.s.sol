// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OptimismBridgeFacet") {}

    function run() public returns (OptimismBridgeFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return OptimismBridgeFacet(predicted);
        }

        deployed = OptimismBridgeFacet(
            factory.deploy(salt, type(OptimismBridgeFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
