// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("DeBridgeFacet") {}

    function run() public returns (DeBridgeFacet deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/debridge.json");
        string memory json = vm.readFile(path);
        address deBridgeGate = json.readAddress(string.concat(".config.", network, ".deBridgeGate"));

        constructorArgs = abi.encode(deBridgeGate);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (DeBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = DeBridgeFacet(
            payable(factory.deploy(salt, bytes.concat(type(DeBridgeFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
