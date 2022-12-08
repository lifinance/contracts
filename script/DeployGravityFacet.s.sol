// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GravityFacet } from "lifi/Facets/GravityFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GravityFacet") {}

    function run() public returns (GravityFacet deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/gravity.json");
        string memory json = vm.readFile(path);
        address gravity = json.readAddress(string.concat(".", network, ".gravityRouter"));

        constructorArgs = abi.encode(gravity);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (GravityFacet(payable(predicted)), constructorArgs);
        }

        deployed = GravityFacet(
            payable(factory.deploy(salt, bytes.concat(type(GravityFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
