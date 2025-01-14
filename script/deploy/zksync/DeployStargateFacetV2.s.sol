// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { StargateFacetV2 } from "lifi/Facets/StargateFacetV2.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("StargateFacetV2") {}

    function run()
        public
        returns (StargateFacetV2 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = StargateFacetV2(deploy(type(StargateFacetV2).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address tokenMessaging = json.readAddress(
            string.concat(".tokenMessaging.", network)
        );

        return abi.encode(tokenMessaging);
    }
}
