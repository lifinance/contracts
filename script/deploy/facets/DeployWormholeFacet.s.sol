// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("WormholeFacet") {}

    function run()
        public
        returns (WormholeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = WormholeFacet(deploy(type(WormholeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/wormhole.json");
        string memory json = vm.readFile(path);

        address wormholeRouter = json.readAddress(
            string.concat(".routers.", network)
        );

        return abi.encode(wormholeRouter);
    }
}
