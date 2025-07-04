// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GlacisFacet } from "lifi/Facets/GlacisFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GlacisFacet") {}

    function run()
        public
        returns (GlacisFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GlacisFacet(deploy(type(GlacisFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/glacis.json");

        address airlift = _getConfigContractAddress(
            path,
            string.concat(".", network, ".airlift")
        );

        return abi.encode(airlift);
    }
}
