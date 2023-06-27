// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    string internal globalConfigPath;
    string internal globalConfigJson;

    constructor() DeployScriptBase("ServiceFeeCollector") {}

    function run()
        public
        returns (ServiceFeeCollector deployed, bytes memory constructorArgs)
    {
        // get path of global config file
        globalConfigPath = string.concat(root, "/config/global.json");

        // read file into json variable
        globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        vm.startBroadcast(deployerPrivateKey);

        constructorArgs = abi.encode(withdrawWalletAddress);

        if (isDeployed()) {
            return (ServiceFeeCollector(predicted), constructorArgs);
        }

        deployed = ServiceFeeCollector(
            factory.deploy(
                salt,
                bytes.concat(
                    type(ServiceFeeCollector).creationCode,
                    constructorArgs
                )
            )
        );

        vm.stopBroadcast();
    }
}
