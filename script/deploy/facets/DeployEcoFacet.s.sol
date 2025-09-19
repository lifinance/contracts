// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("EcoFacet") {}

    function run()
        public
        returns (EcoFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = EcoFacet(deploy(type(EcoFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/eco.json");

        address portal = _getConfigContractAddress(
            path,
            string.concat(".", network, ".portal")
        );

        return abi.encode(portal);
    }
}
