// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";

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
        // obtain address of Permit2 contract in current network from config file
        string memory path = string.concat(root, "/config/permit2Proxy.json");
        string memory json = vm.readFile(path);

        address permit2 = json.readAddress(
            string.concat(".", network, ".permit2")
        );

        return abi.encode(permit2, deployerAddress);
    }
}
