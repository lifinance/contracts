// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CircleBridgeFacet } from "lifi/Facets/CircleBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CircleBridgeFacet") {}

    function run()
        public
        returns (CircleBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CircleBridgeFacet(
            deploy(type(CircleBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/circle.json");
        string memory json = vm.readFile(path);

        address tokenMessenger = json.readAddress(
            string.concat(".", network, ".tokenMessenger")
        );
        address usdc = json.readAddress(string.concat(".", network, ".usdc"));

        return abi.encode(tokenMessenger, usdc);
    }
}
