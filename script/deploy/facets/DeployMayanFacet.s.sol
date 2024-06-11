// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { MayanFacet } from "lifi/Facets/MayanFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("MayanFacet") {}

    function run()
        public
        returns (MayanFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = MayanFacet(deploy(type(MayanFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/mayan.json");
        string memory json = vm.readFile(path);

        address bridge = json.readAddress(
            string.concat(".bridges.", network, ".bridge")
        );

        return abi.encode(bridge);
    }
}
