// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("Permit2Proxy") {}

    function run()
        public
        returns (Permit2Proxy deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = Permit2Proxy(deploy(type(Permit2Proxy).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address deployWalletAddress = globalConfigJson.readAddress(
            ".deployerWallet"
        );

        // get path of permit2 config file
        string memory permit2ProxyConfig = string.concat(
            root,
            "/config/permit2.json"
        );

        // read file into json variable
        string memory permit2ProxyConfigJSON = vm.readFile(permit2ProxyConfig);

        // extract wrapped token address for the given network
        address permit2Address = permit2ProxyConfigJSON.readAddress(
            string.concat(".", network)
        );

        return abi.encode(deployWalletAddress, permit2Address);
    }
}
