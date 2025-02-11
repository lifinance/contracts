// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SquidFacet } from "lifi/Facets/SquidFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SquidFacet") {}

    function run()
        public
        returns (SquidFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = SquidFacet(deploy(type(SquidFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/squid.json");

        address router = _getConfigContractAddress(
            path,
            string.concat(".", network, ".router"),
            false
        );

        return abi.encode(router);
    }
}
