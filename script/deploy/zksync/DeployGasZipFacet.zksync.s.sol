// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GasZipFacet } from "lifi/Facets/GasZipFacet.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GasZipFacet") {}

    function run()
        public
        returns (GasZipFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GasZipFacet(deploy(type(GasZipFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/gaszip.json");

        address gasZipRouter = _getConfigContractAddress(
            path,
            string.concat(".gasZipRouters.", network),
            false
        );

        return abi.encode(gasZipRouter);
    }
}
