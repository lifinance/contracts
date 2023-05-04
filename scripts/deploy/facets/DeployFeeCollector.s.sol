// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("FeeCollector") {}

    function run()
        public
        returns (FeeCollector deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);

        constructorArgs = abi.encode(deployerAddress);

        if (isDeployed()) {
            return (FeeCollector(predicted), constructorArgs);
        }

        deployed = FeeCollector(
            factory.deploy(
                salt,
                bytes.concat(type(FeeCollector).creationCode, constructorArgs)
            )
        );

        vm.stopBroadcast();
    }
}
