// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("ERC20Proxy") {}

    function run()
        public
        returns (ERC20Proxy deployed, bytes memory constructorArgs)
    {
        constructorArgs = abi.encode(deployerAddress);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (ERC20Proxy(predicted), constructorArgs);
        }

        deployed = ERC20Proxy(
            factory.deploy(
                salt,
                bytes.concat(type(ERC20Proxy).creationCode, constructorArgs)
            )
        );

        vm.stopBroadcast();
    }
}
