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

        address composer = _getConfigContractAddress(
            path,
            string.concat(".composers.", network),
            false
        );

        return abi.encode(composer);
    }
}
