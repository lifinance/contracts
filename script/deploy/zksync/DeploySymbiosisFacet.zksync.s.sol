// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SymbiosisFacet } from "lifi/Facets/SymbiosisFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SymbiosisFacet") {}

    function run()
        public
        returns (SymbiosisFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = SymbiosisFacet(deploy(type(SymbiosisFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/symbiosis.json");

        address metaRouter = _getConfigContractAddress(
            path,
            string.concat(".", network, ".metaRouter")
        );
        address gateway = _getConfigContractAddress(
            path,
            string.concat(".", network, ".gateway")
        );

        return abi.encode(metaRouter, gateway);
    }
}
