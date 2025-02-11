// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("PolygonBridgeFacet") {}

    function run()
        public
        returns (PolygonBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = PolygonBridgeFacet(
            deploy(type(PolygonBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/polygon.json");

        address rootChainManager = _getConfigContractAddress(
            path,
            string.concat(".", network, ".rootChainManager"),
            false
        );
        address erc20Predicate = _getConfigContractAddress(
            path,
            string.concat(".", network, ".erc20Predicate"),
            false
        );

        return abi.encode(rootChainManager, erc20Predicate);
    }
}
