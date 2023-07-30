// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("StargateFacet") {}

    function run()
        public
        returns (StargateFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = StargateFacet(deploy(type(StargateFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address stargateRouter = json.readAddress(
            string.concat(".routers.", network)
        );
        address stargateNativeRouter = json.readAddress(
            string.concat(".nativeRouters.", network)
        );

        return abi.encode(stargateRouter, stargateNativeRouter);
    }
}
