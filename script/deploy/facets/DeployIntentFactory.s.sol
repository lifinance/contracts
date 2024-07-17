// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { IntentFactory } from "lifi/Periphery/IntentFactory.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("IntentFactory") {}

    function run()
        public
        returns (IntentFactory deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = IntentFactory(deploy(type(IntentFactory).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract intentExecutorWallet address
        address intentExecutorWalletAddress = globalConfigJson.readAddress(
            ".intentExecutorWallet"
        );

        return abi.encode(intentExecutorWalletAddress);
    }
}
