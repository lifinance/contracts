// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("ServiceFeeCollector") {}

    function run()
        public
        returns (ServiceFeeCollector deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);

        constructorArgs = abi.encode(deployerAddress);

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
