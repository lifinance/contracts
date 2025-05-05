// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ERC20Proxy") {}

    function run()
        public
        returns (ERC20Proxy deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ERC20Proxy(deploy(type(ERC20Proxy).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract withdrawWallet address
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        return abi.encode(withdrawWalletAddress);
    }
}
