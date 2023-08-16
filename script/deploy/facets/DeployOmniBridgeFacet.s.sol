// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OmniBridgeFacet") {}

    function run()
        public
        returns (OmniBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = OmniBridgeFacet(deploy(type(OmniBridgeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/omni.json");
        string memory json = vm.readFile(path);

        address foreignOmniBridge = json.readAddress(
            string.concat(".", network, ".foreignOmniBridge")
        );
        address wethOmniBridge = json.readAddress(
            string.concat(".", network, ".wethOmniBridge")
        );

        return abi.encode(foreignOmniBridge, wethOmniBridge);
    }
}
