// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { FeeForwarder } from "lifi/Periphery/FeeForwarder.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("FeeForwarder") {}

    function run()
        public
        returns (FeeForwarder deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = FeeForwarder(deploy(type(FeeForwarder).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        address withdrawWallet = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        return abi.encode(withdrawWallet);
    }
}
