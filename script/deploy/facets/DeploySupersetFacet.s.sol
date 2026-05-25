// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SupersetFacet") {}

    function run()
        public
        returns (SupersetFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = SupersetFacet(deploy(type(SupersetFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory supersetPath = string.concat(
            root,
            "/config/superset.json"
        );
        address poolManager = _getConfigContractAddress(
            supersetPath,
            string.concat(".poolManager.", network)
        );

        return abi.encode(poolManager);
    }
}
