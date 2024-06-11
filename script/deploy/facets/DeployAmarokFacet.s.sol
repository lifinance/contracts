// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AmarokFacet") {}

    function run()
        public
        returns (AmarokFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = AmarokFacet(deploy(type(AmarokFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/amarok.json");
        string memory json = vm.readFile(path);

        address connextHandler = json.readAddress(
            string.concat(".", network, ".connextHandler")
        );

        return abi.encode(connextHandler);
    }
}
