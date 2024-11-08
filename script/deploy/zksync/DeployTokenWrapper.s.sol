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
        // get path of global network config file
        string memory networkConfig = string.concat(
            root,
            "/config/networks.json"
        );

        // read file into json variable
        string memory networkConfigJSON = vm.readFile(networkConfig);

        // extract wrapped token address for the given network
        address wrappedNativeAddress = networkConfigJSON.readAddress(
            string.concat(".", network, ".wrappedNativeAddress")
        );

        return abi.encode(wrappedNativeAddress);
    }
}
