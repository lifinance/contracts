// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("WormholeFacet") {}

    function run() public returns (WormholeFacet deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/wormhole.json");
        string memory json = vm.readFile(path);
        address wormholeRouter = json.readAddress(string.concat(".", network, ".wormholeRouter"));

        constructorArgs = abi.encode(wormholeRouter);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (WormholeFacet(payable(predicted)), constructorArgs);
        }

        deployed = WormholeFacet(
            payable(factory.deploy(salt, bytes.concat(type(WormholeFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
