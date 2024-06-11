// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CBridgeFacetPacked") {}

    function run()
        public
        returns (CBridgeFacetPacked deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = CBridgeFacetPacked(
            deploy(type(CBridgeFacetPacked).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/cbridge.json");
        string memory json = vm.readFile(path);

        address cBridge = json.readAddress(
            string.concat(".", network, ".cBridge")
        );

        return abi.encode(cBridge, deployerAddress);
    }
}
