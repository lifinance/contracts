// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { IntentFactory } from "lifi/Periphery/IntentFactory.sol";
import { Intent } from "lifi/Helpers/Intent.sol";

contract DeployScript is DeployScriptBase {
    Intent implementation;

    constructor() DeployScriptBase("IntentFactory") {}

    function run()
        public
        returns (IntentFactory deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);
        implementation = new Intent();
        vm.stopBroadcast();
        constructorArgs = getConstructorArgs();

        deployed = IntentFactory(deploy(type(IntentFactory).creationCode));
    }

    function getConstructorArgs()
        internal
        view
        override
        returns (bytes memory)
    {
        return abi.encode(address(implementation));
    }
}
