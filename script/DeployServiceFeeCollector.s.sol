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

        address owner = address(0x8932eb23BAD9bDdB5cF81426F78279A53c6c3b71);
        // or for testing:
        // address owner = deployerAddress
        constructorArgs = abi.encode(owner);

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
