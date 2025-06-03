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
        // get the address of the LiFiDiamond for the given network
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        address diamond = _getConfigContractAddress(path, ".LiFiDiamond");

        // get the Permit2 contract address for the given network
        path = string.concat(root, "/config/permit2Proxy.json");

        address permit2Address = _getConfigContractAddress(
            path,
            string.concat(".", network)
        );

        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address withdrawWalletAddress = globalConfigJson.readAddress(
            ".withdrawWallet"
        );

        return abi.encode(diamond, permit2Address, withdrawWalletAddress);
    }
}
