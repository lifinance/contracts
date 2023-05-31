// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DiamondCutFacet") {}

    function run() public returns (DiamondCutFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return DiamondCutFacet(predicted);
        }

        deployed = DiamondCutFacet(
            factory.deploy(salt, type(DiamondCutFacet).creationCode)
        );

        vm.stopBroadcast();
    }
}
