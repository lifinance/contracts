// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CBridgeFacet") {}

    function run()
        public
        returns (CBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CBridgeFacet(deploy(type(CBridgeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/cbridge.json");
        string memory json = vm.readFile(path);

        address cBridge = json.readAddress(
            string.concat(".", network, ".cBridge")
        );

        return abi.encode(cBridge);
    }
}
