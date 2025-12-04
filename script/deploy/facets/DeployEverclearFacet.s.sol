// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { EverclearFacet } from "lifi/Facets/EverclearFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("EverclearFacet") {}

    function run()
        public
        returns (EverclearFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = EverclearFacet(deploy(type(EverclearFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/everclear.json");

        address feeAdapter = _getConfigContractAddress(
            path,
            string.concat(".", network, ".feeAdapter")
        );

        return abi.encode(feeAdapter);
    }
}
