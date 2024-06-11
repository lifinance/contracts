// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("StandardizedCallFacetFacet") {}

    function run() public returns (StandardizedCallFacet deployed) {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (StandardizedCallFacet(payable(predicted)));
        }

        deployed = StandardizedCallFacet(
            payable(
                factory.deploy(salt, type(StandardizedCallFacet).creationCode)
            )
        );

        vm.stopBroadcast();
    }
}
