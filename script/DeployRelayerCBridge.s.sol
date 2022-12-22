// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RelayerCBridge } from "lifi/Periphery/RelayerCBridge.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("RelayerCBridge") {}

    function run() public returns (RelayerCBridge deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/cBridge.json");
        string memory json = vm.readFile(path);
        address messageBus = json.readAddress(string.concat(".", network, ".messageBus"));
        if (messageBus == address(0)) revert("MessageBus not found in cBridge config file");

        path = string.concat(root, "/deployments/", network, ".", fileSuffix, "json");
        json = vm.readFile(path);
        address executor = json.readAddress(".Executor");
        if (executor == address(0)) revert("Executor not found in deployments file");
        address diamond = json.readAddress(".LiFiDiamond");
        if (diamond == address(0)) revert("LiFiDiamond not found in deployments file");

        constructorArgs = abi.encode(deployerAddress, messageBus, diamond, executor);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (RelayerCBridge(payable(predicted)), constructorArgs);
        }

        deployed = RelayerCBridge(
            payable(factory.deploy(salt, bytes.concat(type(RelayerCBridge).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
