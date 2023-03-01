// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { GetGasFacet } from "lifi/Facets/GetGasFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GetGasFacet") {}

    function run()
        public
        returns (GetGasFacet deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (GetGasFacet(predicted), "");
        }

        deployed = GetGasFacet(
            factory.deploy(
                salt,
                type(GetGasFacet).creationCode
            )
        );

        vm.stopBroadcast();
    }
}
