// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

contract DeployPolygonBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "PolygonBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(PolygonBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/polygon.json");
        string memory json = vm.readFile(path);

        address rootChainManager = json.readAddress(
            string.concat(".", _network, ".rootChainManager")
        );
        address erc20Predicate = json.readAddress(
            string.concat(".", _network, ".erc20Predicate")
        );

        return abi.encode(rootChainManager, erc20Predicate);
    }
}
