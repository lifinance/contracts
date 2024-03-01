// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RoninBridgeFacet } from "lifi/Facets/RoninBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("RoninBridgeFacet") {}

    function run()
        public
        returns (RoninBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = RoninBridgeFacet(
            deploy(type(RoninBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/ronin.json");
        string memory json = vm.readFile(path);

        address gateway = json.readAddress(
            string.concat(".", network, ".gateway")
        );

        return abi.encode(gateway);
    }
}
