// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("DeBridgeFacet") {}

    function run()
        public
        returns (DeBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = DeBridgeFacet(deploy(type(DeBridgeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/debridge.json");
        string memory json = vm.readFile(path);

        address deBridgeGate = json.readAddress(
            string.concat(".config.", network, ".deBridgeGate")
        );

        return abi.encode(deBridgeGate);
    }
}
