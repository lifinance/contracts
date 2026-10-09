// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { M0Facet } from "lifi/Facets/M0Facet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("M0Facet") {}

    function run()
        public
        returns (M0Facet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = M0Facet(deploy(type(M0Facet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/m0.json");

        address orderBook = _getConfigContractAddress(
            path,
            string.concat(".", network, ".orderBook")
        );

        return abi.encode(orderBook);
    }
}
