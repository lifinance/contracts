// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { HopFacetPacked } from "lifi/Facets/HopFacetPacked.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("HopFacetPacked") {}

    function run()
        public
        returns (HopFacetPacked deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);

        constructorArgs = abi.encode(deployerAddress);

        if (isDeployed()) {
            return (HopFacetPacked(predicted), constructorArgs);
        }

        deployed = HopFacetPacked(
            factory.deploy(
                salt,
                bytes.concat(
                    type(HopFacetPacked).creationCode,
                    constructorArgs
                )
            )
        );

        vm.stopBroadcast();
    }
}
