// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";
import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CBridgeFacet") {}

    function run() public returns (CBridgeFacet deployed, bytes memory constructorArgs) {
        // get messageBus address
        string memory path = string.concat(vm.projectRoot(), "/config/cbridge.json");
        string memory json = vm.readFile(path);
        address messageBus = json.readAddress(string.concat(".", network, ".messageBus"));
        if (messageBus == address(0))
            revert(string.concat("MessageBus address not found in deployment file for network ", network));
        console.log("messageBus address: ", messageBus);
        // get relayer address
        path = string.concat(vm.projectRoot(), "/deployments/", network, ".json");
        //! add fileSuffix
        json = vm.readFile(path);
        address relayer = json.readAddress(".RelayerCBridge");
        console.log("Relayer address: ", relayer);
        if (relayer == address(0))
            revert(string.concat("Relayer address not found in deployment file for network ", network));

        constructorArgs = abi.encode(messageBus, relayer);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = CBridgeFacet(
            payable(factory.deploy(salt, bytes.concat(type(CBridgeFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
