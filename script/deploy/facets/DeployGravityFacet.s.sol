// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GravityFacet } from "lifi/Facets/GravityFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GravityFacet") {}

    function run()
        public
        returns (GravityFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GravityFacet(deploy(type(GravityFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/gravity.json");
        string memory json = vm.readFile(path);

        address gravity = json.readAddress(
            string.concat(".", network, ".gravityRouter")
        );

        return abi.encode(gravity);
    }
}
