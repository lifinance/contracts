// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AxelarExecutor } from "lifi/Periphery/AxelarExecutor.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AxelarExecutor") {}

    function run()
        public
        returns (AxelarExecutor deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/axelar.json"
        );
        string memory json = vm.readFile(path);
        address gateway = json.readAddress(
            string.concat(".", network, ".gateway")
        );

        constructorArgs = abi.encode(deployerAddress, gateway);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (AxelarExecutor(predicted), constructorArgs);
        }

        deployed = AxelarExecutor(
            factory.deploy(
                salt,
                bytes.concat(
                    type(AxelarExecutor).creationCode,
                    constructorArgs
                )
            )
        );

        vm.stopBroadcast();
    }
}
