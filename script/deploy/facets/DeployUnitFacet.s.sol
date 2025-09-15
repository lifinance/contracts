// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("UnitFacet") {}

    function run()
        public
        returns (UnitFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = UnitFacet(deploy(type(UnitFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        // If you don't have a constructor or it doesn't take any arguments, you can remove this function
        string memory path = string.concat(root, "/config/unit.json");
        string memory json = vm.readFile(path);

        bytes memory unitNodePublicKey = json.readBytes(".unitNodePublicKey");
        bytes memory h1NodePublicKey = json.readBytes(".h1NodePublicKey");
        bytes memory fieldNodePublicKey = json.readBytes(".fieldNodePublicKey");

        return abi.encode(unitNodePublicKey, h1NodePublicKey, fieldNodePublicKey);
    }
}
