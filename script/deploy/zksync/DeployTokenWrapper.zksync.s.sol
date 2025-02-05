// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("TokenWrapper") {}

    function run()
        public
        returns (TokenWrapper deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = TokenWrapper(deploy(type(TokenWrapper).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // get path of global config file
        string memory path = string.concat(root, "/config/networks.json");

        // extract wrapped token address for the given network
        address wrappedNativeAddress = _getConfigContractAddress(
            path,
            string.concat(".", network, ".wrappedNativeAddress")
        );

        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        return abi.encode(wrappedNativeAddress, refundWalletAddress);
    }
}
