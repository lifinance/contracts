// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DexManagerFacet") {}

    function run() public returns (DexManagerFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return DexManagerFacet(predicted);
        }

        deployed = DexManagerFacet(factory.deploy(salt, type(DexManagerFacet).creationCode));

        vm.stopBroadcast();
    }
}
